import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "@/lib/prisma";
import { crawlWebsite, normalizeDomain } from "@/lib/crawler-service";
import { extractAllEvidenceForPage, type ScanContext } from "@/lib/extractors";
import { isCrawlOk } from "@/lib/extractors/types";
import { fetchPageSpeedForPages, PSI_MAX_PRIORITY_PAGES } from "@/lib/pagespeed-service";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Standalone evidence-extraction CLI — crawls a site and runs every category extractor
 * (lib/extractors/index.ts) to produce normalized EvidenceItem records, then stops. Deliberately
 * does not call lib/scoring.ts: the Scan is left in "scoring" status (crawl + extraction done,
 * ready to be scored) rather than advanced to "complete". Useful for inspecting exactly what
 * evidence the extractors collect before any scoring logic touches it.
 *
 * Usage: npm run extract -- <url> [outputJsonPath]
 */

const DEFAULT_MAX_PAGES = 25;

export type NormalizedEvidenceItem = {
  id: string;
  scanId: string;
  category: string;
  source: string;
  severity: string;
  finding: string;
  url: string | null;
  confidence: number;
  rawData: unknown;
  createdAt: string;
};

export type ExtractCliResult = {
  scanId: string;
  rootUrl: string;
  blockedByRobots: boolean;
  pagesCrawled: number;
  evidenceItems: NormalizedEvidenceItem[];
};

export async function runExtractCli(rawUrl: string, maxPages = DEFAULT_MAX_PAGES): Promise<ExtractCliResult> {
  if (!rawUrl) {
    throw new Error("Usage: npm run extract -- <url> [outputJsonPath]");
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
    const crawl = await crawlWebsite({ rootUrl, scanId: scan.id, maxPages });

    if (crawl.blockedByRobots) {
      await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          failureReason:
            "robots.txt disallows crawling for all user agents (Disallow: / under User-agent: *)",
        },
      });
      return { scanId: scan.id, rootUrl, blockedByRobots: true, pagesCrawled: 0, evidenceItems: [] };
    }

    const homepageForPsi = crawl.pages.find((p) => p.requestedUrl === rootUrl) ?? crawl.pages[0];
    const priorityPagesForPsi = crawl.pages
      .filter((p) => isCrawlOk(p) && p.requestedUrl !== homepageForPsi?.requestedUrl)
      .slice(0, PSI_MAX_PRIORITY_PAGES);
    const pagesToAnalyzeForPsi = homepageForPsi
      ? [homepageForPsi, ...priorityPagesForPsi]
      : priorityPagesForPsi;
    const pageSpeedResults = await fetchPageSpeedForPages(
      pagesToAnalyzeForPsi.map((p) => p.requestedUrl),
      process.env.PAGESPEED_API_KEY
    );

    const scanContext: ScanContext = {
      scanId: scan.id,
      rootUrl,
      homepageUrl: rootUrl,
      robotsFound: crawl.robotsFound,
      robotsTxtContent: crawl.robotsTxtContent,
      sitemapFound: crawl.sitemapFound,
      llmsTxtFound: crawl.llmsTxtFound,
      allPages: crawl.pages,
      wordpressDiagnostics: crawl.wordpressDiagnostics,
      pageSpeedResults,
      httpsRedirectCheck: crawl.httpsRedirectCheck,
    };

    const draftEvidence = crawl.pages.flatMap((page) => extractAllEvidenceForPage(scanContext, page));

    const homepage = crawl.pages.find((p) => p.requestedUrl === rootUrl) ?? crawl.pages[0];
    const isWordPress = homepage?.isWordPress ?? false;
    await prisma.client.update({
      where: { id: client.id },
      data: { detectedCms: isWordPress ? "wordpress" : "other" },
    });

    const createdEvidence = await prisma.evidenceItem.createManyAndReturn({
      data: draftEvidence.map((item) => ({
        scanId: scan.id,
        category: item.category,
        source: item.source,
        severity: item.severity,
        finding: item.finding,
        url: item.url,
        rawData: (item.rawData as Prisma.InputJsonValue) ?? undefined,
        confidence: item.confidence,
      })),
    });

    // "scoring" signals crawl + extraction are done and this scan is ready to be scored — scoring
    // itself is out of scope here on purpose (see lib/scoring.ts, invoked only by the full scan
    // pipeline in lib/scan-pipeline.ts).
    await prisma.scan.update({
      where: { id: scan.id },
      data: { status: "scoring", pagesCrawled: crawl.pages.length },
    });

    return {
      scanId: scan.id,
      rootUrl,
      blockedByRobots: false,
      pagesCrawled: crawl.pages.length,
      evidenceItems: createdEvidence.map((e) => ({
        id: e.id,
        scanId: e.scanId,
        category: e.category,
        source: e.source,
        severity: e.severity,
        finding: e.finding,
        url: e.url,
        confidence: e.confidence,
        rawData: e.rawData,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    await prisma.scan
      .update({
        where: { id: scan.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          failureReason: error instanceof Error ? error.message : "Unknown error during extraction",
        },
      })
      .catch(() => {});
    throw error;
  }
}

function printSummary(result: ExtractCliResult): void {
  console.log(`\nScan ${result.scanId} — ${result.rootUrl}`);
  if (result.blockedByRobots) {
    console.log("Blocked by robots.txt — no evidence was extracted.");
    return;
  }
  console.log(`Pages crawled: ${result.pagesCrawled}`);
  console.log(`Evidence items collected: ${result.evidenceItems.length}\n`);

  const byCategory = new Map<string, number>();
  for (const item of result.evidenceItems) {
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  }
  for (const [category, count] of [...byCategory.entries()].sort()) {
    console.log(`  ${category}: ${count}`);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  const outPath = process.argv[3];
  try {
    const result = await runExtractCli(url);
    printSummary(result);

    if (outPath) {
      const resolved = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, JSON.stringify(result, null, 2) + "\n");
      console.log(`\nWrote sample JSON output to ${outPath}`);
    }
  } catch (error) {
    console.error("Extraction failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
