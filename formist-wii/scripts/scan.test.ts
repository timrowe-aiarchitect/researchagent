import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { runScanCli } from "@/scripts/scan";

type MockSite = { baseUrl: string; close: () => Promise<void> };

async function startMockSite(routes: Record<string, string>): Promise<MockSite> {
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const body = routes[url];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
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

const cleanupClientIds: string[] = [];

afterEach(async () => {
  while (cleanupClientIds.length > 0) {
    const id = cleanupClientIds.pop()!;
    await prisma.client.delete({ where: { id } }).catch(() => {});
  }
});

describe("runScanCli", () => {
  it("rejects a missing URL", async () => {
    await expect(runScanCli("")).rejects.toThrow("Usage: npm run scan");
  });

  it("rejects an unparseable URL", async () => {
    await expect(runScanCli("not a url")).rejects.toThrow("is not a valid URL");
  });

  it("crawls a site end-to-end, persisting a Client, a completed Scan, and Page rows", async () => {
    const site = await startMockSite({
      "/": `<!doctype html><html lang="en"><head>
              <title>Acme Home</title>
              <meta name="description" content="Acme builds things.">
            </head><body>
              <h1>Welcome to Acme</h1>
              <p>Some homepage content here for word counting purposes.</p>
              <nav><a href="/about">About</a></nav>
            </body></html>`,
      "/about": `<!doctype html><html lang="en"><head><title>About Acme</title></head><body>
              <h1>About</h1>
              <p>About page content.</p>
            </body></html>`,
      "/robots.txt": "User-agent: *\nAllow: /\n",
    });

    try {
      const result = await runScanCli(site.baseUrl, 3);
      const client = await prisma.client.findUniqueOrThrow({ where: { rootUrl: site.baseUrl } });
      cleanupClientIds.push(client.id);

      expect(result.blockedByRobots).toBe(false);
      expect(result.robotsFound).toBe(true);
      expect(result.pagesCrawled).toBeGreaterThan(0);
      expect(result.pages.some((p) => p.url === site.baseUrl)).toBe(true);

      const homepage = result.pages.find((p) => p.url === site.baseUrl)!;
      expect(homepage.crawlStatus).toBe("success");
      expect(homepage.title).toBe("Acme Home");
      expect(homepage.wordCount).toBeGreaterThan(0);
      expect(homepage.screenshotPath).toMatch(new RegExp(`^/screenshots/${result.scanId}/`));

      const scan = await prisma.scan.findUniqueOrThrow({ where: { id: result.scanId } });
      expect(scan.status).toBe("complete");
      expect(scan.pagesCrawled).toBe(result.pagesCrawled);
      expect(scan.requestedBy).toBe("cli");

      const pages = await prisma.page.findMany({ where: { scanId: result.scanId } });
      expect(pages.length).toBe(result.pagesCrawled);
    } finally {
      await site.close();
    }
  }, 30000);

  it("marks the scan failed when robots.txt disallows all crawling", async () => {
    const site = await startMockSite({
      "/": "<html><body>hi</body></html>",
      "/robots.txt": "User-agent: *\nDisallow: /\n",
    });

    try {
      const result = await runScanCli(site.baseUrl, 3);
      const client = await prisma.client.findUniqueOrThrow({ where: { rootUrl: site.baseUrl } });
      cleanupClientIds.push(client.id);

      expect(result.blockedByRobots).toBe(true);
      expect(result.pagesCrawled).toBe(0);

      const scan = await prisma.scan.findUniqueOrThrow({ where: { id: result.scanId } });
      expect(scan.status).toBe("failed");
      expect(scan.failureReason).toContain("robots.txt");
    } finally {
      await site.close();
    }
  }, 30000);
});
