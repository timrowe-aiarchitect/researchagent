const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 45000;
const PSI_CALL_DELAY_MS = 300;

export const PSI_MAX_PRIORITY_PAGES = 5;

export type PsiStrategy = "mobile" | "desktop";

export type LighthouseScores = {
  performance: number | null;
  accessibility: number | null;
  seo: number | null;
  bestPractices: number | null;
};

/** Lab (synthetic, single Lighthouse run) timing metrics — always available when the run succeeds. */
export type LabMetrics = {
  lcpMs: number | null;
  clsScore: number | null;
  fcpMs: number | null;
  ttfbMs: number | null;
  speedIndexMs: number | null;
  totalBlockingTimeMs: number | null;
};

/** Real-user (CrUX) field data for the official Core Web Vitals — absent for lower-traffic pages. */
export type FieldMetrics = {
  source: "page" | "origin";
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
};

export type PageSpeedResult = {
  strategy: PsiStrategy;
  fetched: boolean;
  error: string | null;
  scores: LighthouseScores;
  lab: LabMetrics;
  field: FieldMetrics | null;
  /**
   * A curated slice of the raw API response backing this result — the score categories, the
   * handful of audits we read, and the CrUX loadingExperience objects. Deliberately excludes the
   * full Lighthouse audit/opportunity tree (dozens of unrelated audits, often hundreds of KB)
   * since that isn't part of what was asked for and would bloat every evidence row.
   */
  raw: Record<string, unknown> | null;
};

const emptyResult = (strategy: PsiStrategy, error: string): PageSpeedResult => ({
  strategy,
  fetched: false,
  error,
  scores: { performance: null, accessibility: null, seo: null, bestPractices: null },
  lab: {
    lcpMs: null,
    clsScore: null,
    fcpMs: null,
    ttfbMs: null,
    speedIndexMs: null,
    totalBlockingTimeMs: null,
  },
  field: null,
  raw: null,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toScore(value: unknown): number | null {
  return typeof value === "number" ? Math.round(value * 100) : null;
}

function auditNumericValue(audits: Record<string, unknown>, id: string): number | null {
  const audit = audits[id] as { numericValue?: unknown } | undefined;
  return typeof audit?.numericValue === "number" ? audit.numericValue : null;
}

type CruxMetrics = Record<string, { percentile?: number } | undefined>;

function fieldMetric(metrics: CruxMetrics | undefined, key: string, scale = 1): number | null {
  const percentile = metrics?.[key]?.percentile;
  return typeof percentile === "number" ? percentile / scale : null;
}

function extractFieldMetrics(
  pageExperience: { metrics?: CruxMetrics } | undefined,
  originExperience: { metrics?: CruxMetrics } | undefined
): FieldMetrics | null {
  const experience = pageExperience ?? originExperience;
  if (!experience?.metrics) return null;
  return {
    source: pageExperience?.metrics ? "page" : "origin",
    lcpMs: fieldMetric(experience.metrics, "LARGEST_CONTENTFUL_PAINT_MS"),
    clsScore: fieldMetric(experience.metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100),
    inpMs: fieldMetric(experience.metrics, "INTERACTION_TO_NEXT_PAINT"),
  };
}

/**
 * Runs a single PageSpeed Insights analysis for one URL/strategy. Never throws — network errors,
 * non-200 responses (including 429 quota-exhausted, which Google returns when no/insufficient
 * API key quota is available), and malformed payloads all degrade to a `fetched: false` result
 * with the error message preserved, so callers can report a graceful "analysis unavailable"
 * finding instead of failing the whole scan.
 */
export async function fetchPageSpeedInsights(
  url: string,
  strategy: PsiStrategy,
  apiKey?: string
): Promise<PageSpeedResult> {
  const params = new URLSearchParams({ url, strategy });
  params.append("category", "performance");
  params.append("category", "accessibility");
  params.append("category", "seo");
  params.append("category", "best-practices");
  if (apiKey) params.set("key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : "Unknown network error";
    return emptyResult(strategy, message);
  }
  clearTimeout(timeout);

  if (!res.ok) {
    let message = `PageSpeed Insights returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // Non-JSON error body — keep the generic HTTP status message.
    }
    return emptyResult(strategy, message);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return emptyResult(strategy, "PageSpeed Insights returned a response that could not be parsed as JSON.");
  }

  const lighthouseResult = payload.lighthouseResult as
    | { categories?: Record<string, { score?: number }>; audits?: Record<string, unknown> }
    | undefined;
  const categories = lighthouseResult?.categories ?? {};
  const audits = lighthouseResult?.audits ?? {};

  const scores: LighthouseScores = {
    performance: toScore(categories.performance?.score),
    accessibility: toScore(categories.accessibility?.score),
    seo: toScore(categories.seo?.score),
    bestPractices: toScore(categories["best-practices"]?.score),
  };

  const lab: LabMetrics = {
    lcpMs: auditNumericValue(audits, "largest-contentful-paint"),
    clsScore: auditNumericValue(audits, "cumulative-layout-shift"),
    fcpMs: auditNumericValue(audits, "first-contentful-paint"),
    ttfbMs: auditNumericValue(audits, "server-response-time"),
    speedIndexMs: auditNumericValue(audits, "speed-index"),
    totalBlockingTimeMs: auditNumericValue(audits, "total-blocking-time"),
  };

  const field = extractFieldMetrics(
    payload.loadingExperience as { metrics?: CruxMetrics } | undefined,
    payload.originLoadingExperience as { metrics?: CruxMetrics } | undefined
  );

  return {
    strategy,
    fetched: true,
    error: null,
    scores,
    lab,
    field,
    raw: {
      categories,
      audits: {
        "largest-contentful-paint": audits["largest-contentful-paint"],
        "cumulative-layout-shift": audits["cumulative-layout-shift"],
        "first-contentful-paint": audits["first-contentful-paint"],
        "server-response-time": audits["server-response-time"],
        "speed-index": audits["speed-index"],
        "total-blocking-time": audits["total-blocking-time"],
      },
      loadingExperience: payload.loadingExperience ?? null,
      originLoadingExperience: payload.originLoadingExperience ?? null,
    },
  };
}

/**
 * Runs mobile + desktop PSI analysis for each URL in sequence (a small delay between calls is
 * polite to the API and reduces the odds of tripping rate limits mid-scan). Intended to be
 * called with the homepage plus up to PSI_MAX_PRIORITY_PAGES other priority pages.
 */
export async function fetchPageSpeedForPages(
  urls: string[],
  apiKey?: string
): Promise<Record<string, { mobile: PageSpeedResult; desktop: PageSpeedResult }>> {
  const results: Record<string, { mobile: PageSpeedResult; desktop: PageSpeedResult }> = {};

  for (const url of urls) {
    const mobile = await fetchPageSpeedInsights(url, "mobile", apiKey);
    await sleep(PSI_CALL_DELAY_MS);
    const desktop = await fetchPageSpeedInsights(url, "desktop", apiKey);
    await sleep(PSI_CALL_DELAY_MS);
    results[url] = { mobile, desktop };
  }

  return results;
}
