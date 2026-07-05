import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  crawlWebsite,
  isKeywordUrl,
  normalizeDomain,
  parseRobots,
  parseSitemapUrls,
} from "@/lib/crawler-service";

// --- Pure helpers: no server, no browser, no DB ---

describe("normalizeDomain", () => {
  it("normalizes to the origin with a trailing slash", () => {
    expect(normalizeDomain("https://example.com/some/page?x=1")).toBe("https://example.com/");
    expect(normalizeDomain("https://example.com")).toBe("https://example.com/");
    expect(normalizeDomain("http://sub.example.com/")).toBe("http://sub.example.com/");
  });
});

describe("isKeywordUrl", () => {
  it("matches priority page keywords in the path", () => {
    expect(isKeywordUrl("https://example.com/about")).toBe(true);
    expect(isKeywordUrl("https://example.com/contact-us")).toBe(true);
    expect(isKeywordUrl("https://example.com/services/design")).toBe(true);
    expect(isKeywordUrl("https://example.com/offerings")).toBe(true);
    expect(isKeywordUrl("https://example.com/pricing")).toBe(true);
    expect(isKeywordUrl("https://example.com/blog/post-1")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isKeywordUrl("https://example.com/random-page")).toBe(false);
    expect(isKeywordUrl("https://example.com/")).toBe(false);
  });
});

describe("parseRobots", () => {
  it("detects a wildcard disallow-all rule", () => {
    const text = "User-agent: *\nDisallow: /\n";
    expect(parseRobots(text).disallowsAll).toBe(true);
  });

  it("does not flag a scoped disallow rule", () => {
    const text = "User-agent: *\nDisallow: /wp-admin/\n";
    expect(parseRobots(text).disallowsAll).toBe(false);
  });

  it("ignores disallow-all rules scoped to a non-wildcard user agent", () => {
    const text = "User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\n";
    expect(parseRobots(text).disallowsAll).toBe(false);
  });
});

describe("parseSitemapUrls", () => {
  it("extracts same-domain <loc> entries and drops other domains", () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
        <url><loc>https://other-domain.test/c</loc></url>
      </urlset>`;
    expect(parseSitemapUrls(xml, "https://example.com")).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});

// --- Integration tests: a local mock HTTP server standing in for a "public" site ---

type MockSite = { baseUrl: string; close: () => Promise<void> };

async function startMockSite(routes: Record<string, string | (() => Promise<string>)>): Promise<MockSite> {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const handler = routes[url];
    if (handler === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const body = typeof handler === "string" ? handler : await handler();
    const contentType = url.endsWith(".xml") ? "application/xml" : url.endsWith(".txt") ? "text/plain" : "text/html";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function createTestScan(rootUrl: string) {
  const client = await prisma.client.create({ data: { rootUrl } });
  const scan = await prisma.scan.create({
    data: { clientId: client.id, requestedBy: "test", status: "queued", pagesRequested: 25 },
  });
  return { clientId: client.id, scanId: scan.id };
}

const cleanupClientIds: string[] = [];

afterEach(async () => {
  while (cleanupClientIds.length > 0) {
    const id = cleanupClientIds.pop()!;
    await prisma.client.delete({ where: { id } }).catch(() => {});
  }
});

describe("crawlWebsite", () => {
  it("respects robots.txt when it disallows all crawling", async () => {
    const site = await startMockSite({
      "/": "<html><body>hi</body></html>",
      "/robots.txt": "User-agent: *\nDisallow: /\n",
    });
    try {
      const { clientId, scanId } = await createTestScan(site.baseUrl);
      cleanupClientIds.push(clientId);

      const result = await crawlWebsite({ rootUrl: site.baseUrl, scanId, maxPages: 5 });

      expect(result.blockedByRobots).toBe(true);
      expect(result.pages).toHaveLength(0);
      const pages = await prisma.page.findMany({ where: { scanId } });
      expect(pages).toHaveLength(0);
    } finally {
      await site.close();
    }
  });

  it("crawls same-domain pages in priority order and persists rich page data", async () => {
    const site = await startMockSite({
      "/": `<!doctype html><html lang="en"><head>
              <title>Acme Home</title>
              <meta name="description" content="Acme builds things.">
              <link rel="canonical" href="/">
              <meta name="viewport" content="width=device-width">
              <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
              <meta property="og:title" content="Acme Home">
            </head><body>
              <h1>Welcome to Acme</h1>
              <img src="/hero.png" alt="Hero image">
              <nav><a href="/nav-page">Nav Page</a></nav>
              <footer><a href="/footer-page">Footer Page</a></footer>
              <a href="/about">About</a>
              <a href="/random-a">Random A</a>
              <a href="/random-b">Random B</a>
              <a href="/random-c">Random C</a>
              <a href="https://external-example.test/">External</a>
            </body></html>`,
      "/nav-page": "<html><head><title>Nav Page</title></head><body><h1>Nav</h1></body></html>",
      "/footer-page":
        "<html><head><title>Footer Page</title></head><body><h1>Footer</h1></body></html>",
      "/about": "<html><head><title>About</title></head><body><h1>About</h1></body></html>",
      "/random-a": "<html><head><title>Random A</title></head><body><h1>A</h1></body></html>",
      "/random-b": "<html><head><title>Random B</title></head><body><h1>B</h1></body></html>",
      "/random-c": "<html><head><title>Random C</title></head><body><h1>C</h1></body></html>",
    });

    try {
      const { clientId, scanId } = await createTestScan(site.baseUrl);
      cleanupClientIds.push(clientId);

      const result = await crawlWebsite({
        rootUrl: site.baseUrl,
        scanId,
        maxPages: 3,
        rateLimitDelayMs: 10,
      });

      expect(result.blockedByRobots).toBe(false);
      expect(result.pages).toHaveLength(3);

      // Only the homepage (tier 0), nav link (tier 1), and footer link (tier 2) should be
      // crawled ahead of the keyword page (tier 3) and generic discovered links (tier 5).
      const crawledUrls = result.pages.map((p) => p.requestedUrl).sort();
      expect(crawledUrls).toEqual([site.baseUrl, `${site.baseUrl}footer-page`, `${site.baseUrl}nav-page`].sort());

      const homepage = result.pages.find((p) => p.requestedUrl === site.baseUrl)!;
      expect(homepage.title).toBe("Acme Home");
      expect(homepage.metaDescription).toBe("Acme builds things.");
      expect(homepage.h1).toBe("Welcome to Acme");
      expect(homepage.wordCount).toBeGreaterThan(0);
      expect(homepage.images).toEqual([{ src: `${site.baseUrl}hero.png`, alt: "Hero image" }]);
      expect(homepage.jsonLd).toEqual([{ "@type": "Organization", name: "Acme" }]);
      expect(homepage.openGraph["og:title"]).toBe("Acme Home");
      expect(homepage.hasViewport).toBe(true);
      expect(homepage.externalLinks).toContain("https://external-example.test/");
      expect(homepage.internalLinks).not.toContain("https://external-example.test/");
      expect(homepage.screenshotPath).toMatch(new RegExp(`^/screenshots/${scanId}/`));

      const persisted = await prisma.page.findMany({ where: { scanId }, orderBy: { url: "asc" } });
      expect(persisted).toHaveLength(3);
      const persistedHome = persisted.find((p) => p.url === site.baseUrl)!;
      expect(persistedHome.title).toBe("Acme Home");
      expect(persistedHome.rendered).toBe(true);
      expect(persistedHome.crawlStatus).toBe("success");
    } finally {
      await site.close();
    }
  });

  it("marks a page as timed out instead of hanging when it never responds in time", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/") {
        // Never end the response — simulates an unresponsive page.
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/`;

    try {
      const { clientId, scanId } = await createTestScan(baseUrl);
      cleanupClientIds.push(clientId);

      const result = await crawlWebsite({
        rootUrl: baseUrl,
        scanId,
        maxPages: 1,
        navTimeoutMs: 800,
      });

      expect(result.pages).toHaveLength(1);
      expect(result.pages[0].crawlStatus).toBe("timeout");
      expect(result.pages[0].httpStatus).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
