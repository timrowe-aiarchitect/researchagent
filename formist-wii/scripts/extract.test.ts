import "dotenv/config";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { runExtractCli } from "@/scripts/extract";

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

describe("runExtractCli", () => {
  it("rejects a missing URL", async () => {
    await expect(runExtractCli("")).rejects.toThrow("Usage: npm run extract");
  });

  it("rejects an unparseable URL", async () => {
    await expect(runExtractCli("not a url")).rejects.toThrow("is not a valid URL");
  });

  it("crawls a site, runs every extractor, and persists normalized EvidenceItem rows without scoring", async () => {
    const site = await startMockSite({
      "/": `<!doctype html><html lang="en"><head>
              <title>Acme Home</title>
            </head><body>
              <h1>Welcome to Acme</h1>
              <p>${"Acme builds durable products for homeowners. ".repeat(20)}</p>
              <nav><a href="/about">About</a></nav>
            </body></html>`,
      "/about": `<!doctype html><html lang="en"><head><title>About Acme</title></head><body>
              <h1>About</h1>
              <p>${"We have served customers since 2001. ".repeat(20)}</p>
            </body></html>`,
      "/robots.txt": "User-agent: *\nAllow: /\n",
    });

    try {
      const result = await runExtractCli(site.baseUrl, 3);
      const client = await prisma.client.findUniqueOrThrow({ where: { rootUrl: site.baseUrl } });
      cleanupClientIds.push(client.id);

      expect(result.blockedByRobots).toBe(false);
      expect(result.pagesCrawled).toBeGreaterThan(0);
      expect(result.evidenceItems.length).toBeGreaterThan(0);

      // Every item is a normalized EvidenceItem: category/source/severity/finding/confidence,
      // matching the EvidenceItem Prisma model shape (see prisma/schema.prisma).
      for (const item of result.evidenceItems) {
        expect(typeof item.id).toBe("string");
        expect(typeof item.category).toBe("string");
        expect(typeof item.source).toBe("string");
        expect(["info", "minor", "moderate", "major", "critical"]).toContain(item.severity);
        expect(typeof item.finding).toBe("string");
        expect(typeof item.confidence).toBe("number");
      }

      // Evidence spans more than one category — confirms multiple extractors actually ran, not
      // just one.
      const categories = new Set(result.evidenceItems.map((e) => e.category));
      expect(categories.size).toBeGreaterThan(1);

      const persisted = await prisma.evidenceItem.findMany({ where: { scanId: result.scanId } });
      expect(persisted.length).toBe(result.evidenceItems.length);

      // Deliberately not scored: the scan is left at "scoring" (crawl + extraction done, ready to
      // be scored), never advanced to "complete", and no CategoryScore rows exist.
      const scan = await prisma.scan.findUniqueOrThrow({ where: { id: result.scanId } });
      expect(scan.status).toBe("scoring");
      const categoryScores = await prisma.categoryScore.findMany({ where: { scanId: result.scanId } });
      expect(categoryScores).toHaveLength(0);
    } finally {
      await site.close();
    }
  }, 30000);

  it("marks the scan failed and collects no evidence when robots.txt disallows all crawling", async () => {
    const site = await startMockSite({
      "/": "<html><body>hi</body></html>",
      "/robots.txt": "User-agent: *\nDisallow: /\n",
    });

    try {
      const result = await runExtractCli(site.baseUrl, 3);
      const client = await prisma.client.findUniqueOrThrow({ where: { rootUrl: site.baseUrl } });
      cleanupClientIds.push(client.id);

      expect(result.blockedByRobots).toBe(true);
      expect(result.evidenceItems).toHaveLength(0);

      const scan = await prisma.scan.findUniqueOrThrow({ where: { id: result.scanId } });
      expect(scan.status).toBe("failed");
    } finally {
      await site.close();
    }
  }, 30000);
});
