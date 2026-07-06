import "dotenv/config";
import { fileURLToPath } from "node:url";

import { prisma } from "@/lib/prisma";
import { crawlWebsite, normalizeDomain } from "@/lib/crawler-service";

/**
 * Standalone crawler CLI — exercises just the crawler service (URL normalization, sitemap
 * discovery, same-domain crawling, page extraction, screenshots, Page persistence) without going
 * through the full scan pipeline (no extractors, scoring, or report generation). Useful for
 * quickly checking how the crawler behaves against a given site.
 *
 * Usage: npm run scan -- <url>
 */

const DEFAULT_MAX_PAGES = 25;

export type ScanCliPageSummary = {
  url: string;
  crawlStatus: string;
  title: string | null;
  wordCount: number;
  screenshotPath: string | null;
};

export type ScanCliResult = {
  scanId: string;
  rootUrl: string;
  blockedByRobots: boolean;
  robotsFound: boolean;
  sitemapFound: boolean;
  pagesCrawled: number;
  pages: ScanCliPageSummary[];
};

export async function runScanCli(rawUrl: string, maxPages = DEFAULT_MAX_PAGES): Promise<ScanCliResult> {
  if (!rawUrl) {
    throw new Error("Usage: npm run scan -- <url>");
  }

  let rootUrl: string;
  try {
    rootUrl = normalizeDomain(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }

  const client = await prisma.client.upsert({
    where: { rootUrl },
    update: {},
    create: { rootUrl },
  });

  const scan = await prisma.scan.create({
    data: {
      clientId: client.id,
      requestedBy: "cli",
      status: "crawling",
      pagesRequested: maxPages,
      startedAt: new Date(),
    },
  });

  try {
    const result = await crawlWebsite({ rootUrl, scanId: scan.id, maxPages });

    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: result.blockedByRobots ? "failed" : "complete",
        completedAt: new Date(),
        pagesCrawled: result.pages.length,
        failureReason: result.blockedByRobots
          ? "robots.txt disallows crawling for all user agents (Disallow: / under User-agent: *)"
          : null,
      },
    });

    return {
      scanId: scan.id,
      rootUrl,
      blockedByRobots: result.blockedByRobots,
      robotsFound: result.robotsFound,
      sitemapFound: result.sitemapFound,
      pagesCrawled: result.pages.length,
      pages: result.pages.map((p) => ({
        url: p.requestedUrl,
        crawlStatus: p.crawlStatus,
        title: p.title,
        wordCount: p.wordCount,
        screenshotPath: p.screenshotPath,
      })),
    };
  } catch (error) {
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        failureReason: error instanceof Error ? error.message : "Unknown error during scan",
      },
    });
    throw error;
  }
}

function printSummary(result: ScanCliResult): void {
  console.log(`\nScan ${result.scanId} — ${result.rootUrl}`);
  if (result.blockedByRobots) {
    console.log("Blocked by robots.txt — no pages were crawled.");
    return;
  }
  console.log(`robots.txt found: ${result.robotsFound}`);
  console.log(`sitemap.xml found: ${result.sitemapFound}`);
  console.log(`Pages crawled: ${result.pagesCrawled}\n`);
  for (const page of result.pages) {
    console.log(`- [${page.crawlStatus}] ${page.url}`);
    console.log(`    title: ${page.title ?? "(none)"}  words: ${page.wordCount}`);
    console.log(`    screenshot: ${page.screenshotPath ?? "(none)"}`);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  try {
    const result = await runScanCli(url);
    printSummary(result);
  } catch (error) {
    console.error("Scan failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
