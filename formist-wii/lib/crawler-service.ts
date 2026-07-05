import fs from "node:fs";
import path from "node:path";
import { chromium, type Page as PlaywrightPage } from "playwright";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { CrawlStatus } from "@/generated/prisma/enums";

const MAX_PAGES_HARD_CAP = 25;
const NAV_TIMEOUT_MS = 15000;
const NETWORK_IDLE_TIMEOUT_MS = 4000;
const SCREENSHOT_TIMEOUT_MS = 10000;
const RATE_LIMIT_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "FormistWiiBot/0.1 (+https://formist.studio/wii)";
const AXE_TIMEOUT_MS = 15000;
// Homepage + this many other priority pages get an axe-core accessibility scan (mirrors the
// PageSpeed Insights priority sample in lib/pagespeed-service.ts).
const AXE_MAX_PRIORITY_PAGES = 10;
// Read once at module load and reused across every page's injectScriptTag() call.
const AXE_SOURCE = fs.readFileSync(
  path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf-8"
);

// Lower tier = higher crawl priority. See "Prioritize homepage, top nav pages, footer
// links, about, contact, services, offering, pricing, blog, and sitemap URLs."
const TIER = {
  homepage: 0,
  nav: 1,
  footer: 2,
  keyword: 3,
  sitemap: 4,
  discovered: 5,
} as const;
type Tier = (typeof TIER)[keyof typeof TIER];

const KEYWORD_PATTERNS: RegExp[] = [
  /about/i,
  /contact/i,
  /service/i,
  /offer/i, // offering(s)
  /pricing/i,
  /blog/i,
];

export function normalizeDomain(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return `${parsed.origin}/`;
}

export function isKeywordUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return KEYWORD_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

export type ImageCapture = { src: string | null; alt: string | null };
export type FormCapture = { action: string | null; method: string; fieldCount: number };
export type ScriptCapture = { src: string | null; inline: boolean; snippet: string | null };

export type CrawledPageData = {
  // --- Persisted as Page columns ---
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  crawlStatus: CrawlStatus;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1: string | null;
  h2: string[];
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  images: ImageCapture[];
  forms: FormCapture[];
  buttons: string[];
  jsonLd: unknown[];
  openGraph: Record<string, string | null>;
  scripts: ScriptCapture[];
  screenshotPath: string | null;

  // --- Ephemeral signals used only for evidence scoring — not persisted as their own columns ---
  h1Count: number;
  htmlLang: string | null;
  hasViewport: boolean;
  hasFavicon: boolean;
  hasCookieBannerMarkup: boolean;
  /** At least one button/CTA-like element is positioned within the initial 1280x720 viewport. */
  hasCtaAboveFold: boolean;
  /** Body text mentions a free downloadable resource offered in exchange for contact info. */
  hasLeadMagnet: boolean;
  /** Body text uses differentiation-claim language (e.g. "unlike", "only", "patented"). */
  hasDifferentiationLanguage: boolean;
  /** Body text mentions quantified results (client counts, years in business, stats). */
  hasProofPoints: boolean;
  /** Body text names a specific target audience/industry rather than speaking generically. */
  hasAudienceSpecificity: boolean;
  /** Body text mentions sustainability/ESG topics — informational only, not expected of every site. */
  hasEsgSignals: boolean;
  /** Body text uses human-centered/empathy-driven design language — informational only. */
  hasHumanCenteredSignals: boolean;
  metaGenerator: string | null;
  metaRobots: string | null;
  contactLinks: string[];
  headers: Record<string, string>;
  isWordPress: boolean;
  wordpressVersion: string | null;
  wordpressPlugins: string[];
  wordpressTheme: string | null;
  hasWpContentPath: boolean;
  hasWpIncludesPath: boolean;
  wordpressCachingSignals: string[];
  wordpressPageBuilderSignals: string[];
  loadTimeMs: number;
  /** Number of redirect hops before reaching finalUrl (0 = no redirect). */
  redirectChainLength: number;
  footerText: string;
  hasAuthorSignal: boolean;
  hasAddressSignal: boolean;
  hasTrustKeywords: boolean;
  hasFaqPattern: boolean;
  hasShortLeadParagraph: boolean;
  /** Heading levels (1-6) in document order — used to detect skipped levels (e.g. h2 -> h4). */
  headingSequence: number[];
  formFieldTotal: number;
  formFieldLabelled: number;
  linkTexts: LinkTextCapture[];
  /**
   * axe-core violations for this page, grouped by rule (axe's own result shape already groups by
   * rule ID, one entry per rule with all affected elements). null means axe wasn't run on this
   * page at all — either it's outside the homepage + AXE_MAX_PRIORITY_PAGES sample, or the run
   * failed (see axeError). An empty array means axe ran successfully and found zero violations.
   */
  axeViolations: AxeViolationSummary[] | null;
  axeError: string | null;
  // Consumed only by the crawl-queue prioritization in crawlWebsite(), not persisted.
  navLinks: string[];
  footerLinks: string[];
};

export type LinkTextCapture = { text: string; hasAccessibleName: boolean };

export type AxeViolationSummary = {
  ruleId: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  helpUrl: string;
  affectedElementCount: number;
};

/**
 * Passive, single-GET diagnostics for WordPress sites. Every field here comes from an
 * unauthenticated GET to a publicly reachable URL — no forms are submitted, no credentials
 * are attempted, and no exploitation is performed. `attempted` is false when the homepage
 * wasn't detected as WordPress, in which case the rest of the fields are left at their
 * not-checked defaults.
 */
export type WordPressDiagnostics = {
  attempted: boolean;
  wpJson: { reachable: boolean; status: number | null };
  restUsersEndpoint: { reachable: boolean; status: number | null; userCount: number | null };
  xmlrpc: { reachable: boolean; status: number | null };
  loginPage: { reachable: boolean; status: number | null; looksLikeWpLogin: boolean };
  latestCoreVersion: string | null;
};

export type CrawlWebsiteResult = {
  blockedByRobots: boolean;
  robotsFound: boolean;
  robotsTxtContent: string | null;
  sitemapFound: boolean;
  llmsTxtFound: boolean;
  pages: CrawledPageData[];
  wordpressDiagnostics: WordPressDiagnostics | null;
  httpsRedirectCheck: HttpsRedirectCheck;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedFetchText(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<{ status: number; text: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export type RobotsInfo = { fetched: boolean; disallowsAll: boolean; raw: string | null };

/** Minimal robots.txt parser: only checks whether the `*` group disallows the entire site. */
export function parseRobots(text: string): { disallowsAll: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let inWildcardGroup = false;
  let disallowsAll = false;
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key)) {
      inWildcardGroup = value === "*";
    } else if (/^disallow$/i.test(key) && inWildcardGroup) {
      if (value === "/") disallowsAll = true;
    }
  }
  return { disallowsAll };
}

export async function fetchRobots(origin: string): Promise<RobotsInfo> {
  const res = await timedFetchText(new URL("/robots.txt", origin).toString());
  if (!res || res.status >= 400) return { fetched: false, disallowsAll: false, raw: null };
  return { fetched: true, raw: res.text, ...parseRobots(res.text) };
}

/** Extracts same-domain <loc> entries from a sitemap.xml body. */
export function parseSitemapUrls(xml: string, origin: string): string[] {
  const originHost = new URL(origin).hostname;
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
  return locs.filter((u) => {
    try {
      return new URL(u).hostname === originHost;
    } catch {
      return false;
    }
  });
}

export async function fetchSitemapUrls(origin: string): Promise<string[]> {
  const res = await timedFetchText(new URL("/sitemap.xml", origin).toString());
  if (!res || res.status >= 400) return [];
  return parseSitemapUrls(res.text, origin);
}

/** Presence check only — llms.txt is an emerging, unstandardized convention. */
export async function fetchLlmsTxtPresence(origin: string): Promise<boolean> {
  const res = await timedFetchText(new URL("/llms.txt", origin).toString());
  return Boolean(res && res.status < 400);
}

const WP_VERSION_CHECK_URL = "https://api.wordpress.org/core/version-check/1.7/";

/**
 * Passive WordPress diagnostics: each check is a single, unauthenticated GET to a publicly
 * reachable URL. No forms are submitted (wp-login.php is only ever GET, never POSTed to), no
 * credentials are attempted, and nothing here exploits or modifies anything. Only called when
 * the homepage has already been passively fingerprinted as WordPress via public markup.
 */
export async function fetchWordPressDiagnostics(origin: string): Promise<WordPressDiagnostics> {
  const wpJsonRes = await timedFetchText(new URL("/wp-json/", origin).toString());
  const wpJson = { reachable: Boolean(wpJsonRes && wpJsonRes.status < 400), status: wpJsonRes?.status ?? null };

  await sleep(RATE_LIMIT_DELAY_MS);
  const usersRes = await timedFetchText(new URL("/wp-json/wp/v2/users", origin).toString());
  let userCount: number | null = null;
  if (usersRes && usersRes.status < 400) {
    try {
      const parsed = JSON.parse(usersRes.text);
      if (Array.isArray(parsed)) userCount = parsed.length;
    } catch {
      // Not a JSON array (e.g. an HTML error page) — leave userCount null.
    }
  }
  const restUsersEndpoint = {
    reachable: Boolean(usersRes && usersRes.status < 400),
    status: usersRes?.status ?? null,
    userCount,
  };

  await sleep(RATE_LIMIT_DELAY_MS);
  const xmlrpcRes = await timedFetchText(new URL("/xmlrpc.php", origin).toString());
  // xmlrpc.php replies 405 to a plain GET when present (it only accepts POST), so "reachable"
  // means the endpoint exists, not that it returned a 2xx.
  const xmlrpc = {
    reachable: Boolean(xmlrpcRes && (xmlrpcRes.status === 405 || xmlrpcRes.status < 400)),
    status: xmlrpcRes?.status ?? null,
  };

  await sleep(RATE_LIMIT_DELAY_MS);
  // A single GET to load the login page — this only reads the rendered form, it never submits it.
  const loginRes = await timedFetchText(new URL("/wp-login.php", origin).toString());
  const loginPage = {
    reachable: Boolean(loginRes && loginRes.status < 400),
    status: loginRes?.status ?? null,
    looksLikeWpLogin: Boolean(loginRes && /id=["']loginform["']|user_login|wp-login/i.test(loginRes.text)),
  };

  await sleep(RATE_LIMIT_DELAY_MS);
  const versionRes = await timedFetchText(WP_VERSION_CHECK_URL);
  let latestCoreVersion: string | null = null;
  if (versionRes && versionRes.status < 400) {
    try {
      const parsed = JSON.parse(versionRes.text) as { offers?: { current?: string }[] };
      latestCoreVersion = parsed.offers?.[0]?.current ?? null;
    } catch {
      latestCoreVersion = null;
    }
  }

  return { attempted: true, wpJson, restUsersEndpoint, xmlrpc, loginPage, latestCoreVersion };
}

export type HttpsRedirectCheck = {
  /** False if nothing responded on plain HTTP at all (e.g. connection refused) — itself a fine
   * outcome, since it means the site cannot be reached over an insecure channel. */
  httpReachable: boolean;
  finalUrl: string | null;
  redirectsToHttps: boolean;
};

/**
 * A single passive GET to the plain-HTTP form of the site's hostname (regardless of which scheme
 * the scan was requested with), following redirects, to check whether HTTP traffic is upgraded to
 * HTTPS. No credentials, no forms, no repeated/aggressive requests — one non-destructive request.
 */
export async function fetchHttpsRedirectCheck(hostname: string): Promise<HttpsRedirectCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${hostname}/`, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    return { httpReachable: true, finalUrl: res.url, redirectsToHttps: res.url.startsWith("https://") };
  } catch {
    return { httpReachable: false, finalUrl: null, redirectsToHttps: false };
  } finally {
    clearTimeout(timeout);
  }
}

function partitionLinks(
  rawLinks: string[],
  origin: string
): { internalLinks: string[]; externalLinks: string[] } {
  const originHost = new URL(origin).hostname;
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const href of rawLinks) {
    try {
      const u = new URL(href);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      if (u.hostname === originHost) internal.add(u.toString());
      else external.add(u.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return { internalLinks: [...internal], externalLinks: [...external] };
}

function slugifyUrl(url: string): string {
  const { pathname } = new URL(url);
  const base = pathname.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "home";
  return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80) || "page";
}

async function captureScreenshot(
  page: PlaywrightPage,
  scanId: string,
  url: string
): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), "public", "screenshots", scanId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${slugifyUrl(url)}.png`;
    await page.screenshot({
      path: path.join(dir, filename),
      fullPage: true,
      timeout: SCREENSHOT_TIMEOUT_MS,
    });
    return `/screenshots/${scanId}/${filename}`;
  } catch {
    return null;
  }
}

type DomExtraction = {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1: string | null;
  h1Count: number;
  h2: string[];
  wordCount: number;
  images: ImageCapture[];
  forms: FormCapture[];
  buttons: string[];
  jsonLd: unknown[];
  openGraph: Record<string, string | null>;
  scripts: ScriptCapture[];
  allLinks: string[];
  navLinks: string[];
  footerLinks: string[];
  contactLinks: string[];
  htmlLang: string | null;
  hasViewport: boolean;
  hasFavicon: boolean;
  hasCookieBannerMarkup: boolean;
  hasCtaAboveFold: boolean;
  hasLeadMagnet: boolean;
  hasDifferentiationLanguage: boolean;
  hasProofPoints: boolean;
  hasAudienceSpecificity: boolean;
  hasEsgSignals: boolean;
  hasHumanCenteredSignals: boolean;
  metaGenerator: string | null;
  metaRobots: string | null;
  assetSrcs: string[];
  hasGutenbergBlocks: boolean;
  hasElementorMarkers: boolean;
  hasDiviMarkers: boolean;
  hasWpBakeryMarkers: boolean;
  hasOxygenMarkers: boolean;
  hasBricksMarkers: boolean;
  footerText: string;
  hasAuthorSignal: boolean;
  hasAddressSignal: boolean;
  hasTrustKeywords: boolean;
  hasFaqPattern: boolean;
  hasShortLeadParagraph: boolean;
  headingSequence: number[];
  formFieldTotal: number;
  formFieldLabelled: number;
  linkTexts: LinkTextCapture[];
};

/* eslint-disable @typescript-eslint/no-explicit-any -- runs inside the browser page, not this module's TS scope */
async function extractDomData(page: PlaywrightPage): Promise<DomExtraction> {
  return page.evaluate(() => {
    // NOTE: no inner named function/arrow bindings here — esbuild (via tsx) can inject a
    // `__name(...)` helper call around them, and since page.evaluate() only ships this
    // callback's own stringified source into the browser, that helper is undefined there.
    const h1El = document.querySelector("h1");
    const bodyText = document.body ? (document.body as any).innerText : "";
    const wordCount = bodyText.trim().length ? bodyText.trim().split(/\s+/).length : 0;

    const openGraph: Record<string, string | null> = {};
    document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
      const prop = m.getAttribute("property");
      if (prop) openGraph[prop] = m.getAttribute("content");
    });

    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => {
        try {
          return JSON.parse(s.textContent || "");
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
    const jsonLdText = JSON.stringify(jsonLd);

    const footerText = [...document.querySelectorAll("footer")]
      .map((f) => (f as any).innerText || "")
      .join(" ")
      .trim()
      .slice(0, 1000);

    const hasAuthorSignal =
      Boolean(document.querySelector('[rel="author"], [itemprop="author"], .author, [class*="byline"]')) ||
      /"@type"\s*:\s*"person"/i.test(jsonLdText) ||
      /"author"\s*:/i.test(jsonLdText);

    const hasAddressSignal =
      Boolean(document.querySelector("address")) || /"@type"\s*:\s*"postaladdress"/i.test(jsonLdText);

    const hasTrustKeywords =
      /certified|accredited|award|since (19|20)\d{2}|years? of experience|testimonial|verified|licensed|insured|bbb accredited/i.test(
        bodyText
      );

    const questionHeadings = [...document.querySelectorAll("h2, h3, h4, dt, summary")].filter((el) =>
      (el.textContent || "").trim().endsWith("?")
    );
    const hasFaqPattern = questionHeadings.length >= 2 || document.querySelectorAll("details").length >= 1;

    const firstParagraph = document.querySelector("p");
    const firstParagraphText = firstParagraph ? (firstParagraph.textContent || "").trim() : "";
    const hasShortLeadParagraph = firstParagraphText.length >= 40 && firstParagraphText.length <= 300;

    // Generic cookie-banner heuristic (distinct from known consent-management-platform vendor
    // scripts, which are matched separately from script src/snippets): a reasonably small element
    // whose id/class/aria-label mentions cookie/consent AND whose text reads like an actual banner
    // (accept/reject/manage preferences), not just any element that happens to have "cookie" in a
    // long utility-class list somewhere on the page.
    const hasCookieBannerMarkup = [
      ...document.querySelectorAll(
        '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i]'
      ),
    ].some((el) => {
      const text = (el.textContent || "").toLowerCase();
      return text.length > 0 && text.length < 2000 && /accept|reject|decline|consent|manage (cookie|preference)/.test(text);
    });

    // Same CTA-like selector used for the `buttons` capture below, checked against the initial
    // viewport (see the explicit { width: 1280, height: 720 } context viewport in crawlWebsite()).
    const hasCtaAboveFold = [
      ...document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], a.btn, a.button, a.cta'
      ),
    ].some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0;
    });

    const hasLeadMagnet =
      /free (guide|ebook|e-book|checklist|template|whitepaper|white paper|download|report|toolkit|consultation)|download (our|the|a|your) (guide|ebook|checklist|whitepaper|report|toolkit)/i.test(
        bodyText
      );

    // Brand-language pattern checks (all "if present" — absence isn't a failure, just an
    // observation) for lib/extractors/extractBrandExperience.ts. Each tests the same bodyText
    // already computed above against a fixed phrase/keyword list — a genuine signal that isn't
    // phrased this way won't be caught, which is reflected in that extractor's confidence values.
    const hasDifferentiationLanguage =
      /\b(unlike|only company|only provider|unique(ly)?|proprietary|exclusiv(e|ely)|first to|patented|industry[\s-]leading|award[\s-]winning)\b/i.test(
        bodyText
      );
    const hasProofPoints =
      /\d[\d,]*\+?\s*(clients?|customers?|projects?|properties|years?( of experience)?|awards?|5[\s-]?star|reviews?)|\$[\d,]+(\.\d+)?[kmb]?\b|\b\d+%\s*(increase|growth|satisfaction|faster|more)/i.test(
        bodyText
      );
    const hasAudienceSpecificity =
      /\bfor (small business(es)?|homeowners?|families|professionals|startups|entrepreneurs|contractors|healthcare providers|dentists|lawyers|realtors|restaurants|nonprofits)\b|specializ(e|ing) in|serving [a-z\s]+(since|for)\b|industries? we serve/i.test(
        bodyText
      );
    const hasEsgSignals =
      /sustainab|carbon neutral|net zero|eco[\s-]?friendly|renewable energy|environmental(ly)? responsib|corporate social responsibility|\bESG\b|fair trade|\bb corp\b|certified b corporation/i.test(
        bodyText
      );
    const hasHumanCenteredSignals =
      /accessib(le|ility) statement|we listen|your needs|tailored to you|inclusiv|every(one|body) deserves|no matter (who|where)|designed for you|human[\s-]centered|customer[\s-]first/i.test(
        bodyText
      );

    const headingSequence = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((el) =>
      Number(el.tagName.slice(1))
    );

    const labelForTargets = new Set(
      [...document.querySelectorAll("label[for]")].map((l) => l.getAttribute("for") || "")
    );
    const formControls = [...document.querySelectorAll("form input, form textarea, form select")].filter(
      (el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        return !["hidden", "submit", "button", "image", "reset"].includes(type);
      }
    );
    const formFieldTotal = formControls.length;
    const formFieldLabelled = formControls.filter((el) => {
      const id = el.getAttribute("id");
      const wrappedInLabel = Boolean(el.closest("label"));
      const ariaLabel = el.getAttribute("aria-label");
      const ariaLabelledby = el.getAttribute("aria-labelledby");
      return Boolean((id && labelForTargets.has(id)) || wrappedInLabel || ariaLabel || ariaLabelledby);
    }).length;

    const linkTexts = [...document.querySelectorAll("a[href]")].map((a) => {
      const text = (a.textContent || "").trim();
      const ariaLabel = a.getAttribute("aria-label");
      return { text, hasAccessibleName: Boolean(text || ariaLabel) };
    });

    return {
      title: document.title || null,
      metaDescription:
        (document.querySelector('meta[name="description"]') as any)?.getAttribute("content") ?? null,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      h1: h1El ? (h1El.textContent || "").trim() : null,
      h1Count: document.querySelectorAll("h1").length,
      h2: [...document.querySelectorAll("h2")]
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean),
      wordCount,
      images: [...document.querySelectorAll("img")].map((img) => ({
        src: (img as HTMLImageElement).src || null,
        alt: img.getAttribute("alt"),
      })),
      forms: [...document.querySelectorAll("form")].map((f) => ({
        action: f.getAttribute("action"),
        method: (f.getAttribute("method") || "get").toLowerCase(),
        fieldCount: f.querySelectorAll("input, textarea, select").length,
      })),
      buttons: [
        ...document.querySelectorAll(
          'button, [role="button"], input[type="submit"], input[type="button"], a.btn, a.button, a.cta'
        ),
      ]
        .map((el) => ((el.textContent || (el as HTMLInputElement).value || "").trim()))
        .filter(Boolean),
      jsonLd,
      openGraph,
      scripts: [...document.querySelectorAll("script")].map((s) => {
        const src = (s as HTMLScriptElement).src || null;
        return {
          src,
          inline: !src,
          // 2000 chars (not the earlier 300) so vendor-detection regexes run against inline
          // analytics/CMP loader snippets, which are often 500-1500 chars themselves.
          snippet: !src ? (s.textContent || "").slice(0, 2000) : null,
        };
      }),
      allLinks: [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href),
      navLinks: [...document.querySelectorAll("nav a[href], header nav a[href]")].map(
        (a) => (a as HTMLAnchorElement).href
      ),
      footerLinks: [...document.querySelectorAll("footer a[href]")].map(
        (a) => (a as HTMLAnchorElement).href
      ),
      contactLinks: [...document.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]')].map(
        (a) => a.getAttribute("href") || ""
      ),
      htmlLang: document.documentElement.getAttribute("lang"),
      hasViewport: Boolean(document.querySelector('meta[name="viewport"]')),
      hasFavicon: Boolean(document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')),
      hasCookieBannerMarkup,
      hasCtaAboveFold,
      hasLeadMagnet,
      hasDifferentiationLanguage,
      hasProofPoints,
      hasAudienceSpecificity,
      hasEsgSignals,
      hasHumanCenteredSignals,
      metaGenerator:
        (document.querySelector('meta[name="generator"]') as any)?.getAttribute("content") ?? null,
      metaRobots:
        (document.querySelector('meta[name="robots"]') as any)?.getAttribute("content") ?? null,
      assetSrcs: [...document.querySelectorAll("link[href], script[src], img[src]")]
        .map((el) => {
          if (el instanceof HTMLLinkElement) return el.href;
          if (el instanceof HTMLScriptElement) return el.src;
          if (el instanceof HTMLImageElement) return el.src;
          return "";
        })
        .filter(Boolean),
      hasGutenbergBlocks: Boolean(document.querySelector('[class*="wp-block-"]')),
      hasElementorMarkers: Boolean(document.querySelector('[class*="elementor-"]')),
      hasDiviMarkers: Boolean(document.querySelector('[class*="et_pb_"]')),
      hasWpBakeryMarkers: Boolean(document.querySelector('[class*="vc_row"], [class*="wpb_"]')),
      hasOxygenMarkers: Boolean(document.querySelector('[class*="ct-section"], [class*="ct-div-block"]')),
      hasBricksMarkers: Boolean(document.querySelector('[class*="brxe-"]')),
      footerText,
      hasAuthorSignal,
      hasAddressSignal,
      hasTrustKeywords,
      hasFaqPattern,
      hasShortLeadParagraph,
      headingSequence,
      formFieldTotal,
      formFieldLabelled,
      linkTexts,
    };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type RawAxeViolation = {
  id: string;
  impact?: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  helpUrl: string;
  nodes?: unknown[];
};
type WindowWithAxe = {
  axe: { run: (context: unknown, options: unknown) => Promise<{ violations: RawAxeViolation[] }> };
};

/**
 * Injects axe-core and runs an automated accessibility scan. Never throws — injection failures
 * (e.g. a strict CSP blocking inline scripts) and timeouts both degrade to a null violations
 * array with `error` set, so one page's failure doesn't affect the rest of the crawl. This is
 * automated screening only: it surfaces axe-core's programmatically detectable violations, not a
 * full WCAG compliance audit (many WCAG success criteria require human judgment).
 */
async function runAxeAnalysis(
  page: PlaywrightPage
): Promise<{ violations: AxeViolationSummary[] | null; error: string | null }> {
  try {
    await page.addScriptTag({ content: AXE_SOURCE });
    const resultPromise = page.evaluate(() =>
      (window as unknown as WindowWithAxe).axe.run(document, { resultTypes: ["violations"] })
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("axe-core analysis timed out")), AXE_TIMEOUT_MS);
    });
    const raw = await Promise.race([resultPromise, timeoutPromise]);
    const violations: AxeViolationSummary[] = raw.violations.map((v) => ({
      ruleId: v.id,
      impact: v.impact ?? null,
      description: v.description,
      helpUrl: v.helpUrl,
      affectedElementCount: v.nodes?.length ?? 0,
    }));
    return { violations, error: null };
  } catch (err) {
    return { violations: null, error: err instanceof Error ? err.message : "Unknown axe-core error" };
  }
}

const KNOWN_CACHING_PLUGIN_SLUGS = [
  "wp-super-cache",
  "w3-total-cache",
  "wp-rocket",
  "wp-fastest-cache",
  "litespeed-cache",
  "sg-cachepress",
  "cache-enabler",
  "comet-cache",
  "wp-optimize",
  "autoptimize",
];

const CACHING_RESPONSE_HEADER_SIGNALS = [
  "x-cache",
  "x-cache-enabled",
  "x-litespeed-cache",
  "cf-cache-status",
  "x-nginx-cache",
  "x-proxy-cache",
];

function detectWordPress(
  metaGenerator: string | null,
  assetSrcs: string[]
): {
  isWordPress: boolean;
  version: string | null;
  plugins: string[];
  theme: string | null;
  hasWpContentPath: boolean;
  hasWpIncludesPath: boolean;
} {
  const version = metaGenerator?.match(/WordPress\s*([\d.]+)/i)?.[1] ?? null;
  const hasWpContentPath = assetSrcs.some((src) => /\/wp-content\//i.test(src));
  const hasWpIncludesPath = assetSrcs.some((src) => /\/wp-includes\//i.test(src));
  const isWordPress =
    Boolean(version) ||
    hasWpContentPath ||
    hasWpIncludesPath ||
    assetSrcs.some((src) => /\/wp-json\//i.test(src));
  const plugins = [
    ...new Set(
      assetSrcs
        .map((src) => src.match(/\/wp-content\/plugins\/([a-z0-9-]+)\//i)?.[1])
        .filter((v): v is string => Boolean(v))
    ),
  ];
  const theme = assetSrcs
    .map((src) => src.match(/\/wp-content\/themes\/([a-z0-9_-]+)\//i)?.[1])
    .find((v): v is string => Boolean(v)) ?? null;
  return { isWordPress, version, plugins, theme, hasWpContentPath, hasWpIncludesPath };
}

/** Detected purely from public asset paths and known plugin slugs / response headers — no probing. */
function detectCachingSignals(headers: Record<string, string>, plugins: string[]): string[] {
  const signals = new Set<string>();
  for (const plugin of plugins) {
    if (KNOWN_CACHING_PLUGIN_SLUGS.includes(plugin)) signals.add(plugin);
  }
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  for (const headerName of CACHING_RESPONSE_HEADER_SIGNALS) {
    if (lowerHeaders[headerName] !== undefined) signals.add(`header:${headerName}`);
  }
  return [...signals];
}

function detectPageBuilderSignals(dom: {
  hasGutenbergBlocks: boolean;
  hasElementorMarkers: boolean;
  hasDiviMarkers: boolean;
  hasWpBakeryMarkers: boolean;
  hasOxygenMarkers: boolean;
  hasBricksMarkers: boolean;
}): string[] {
  const signals: string[] = [];
  if (dom.hasElementorMarkers) signals.push("elementor");
  if (dom.hasDiviMarkers) signals.push("divi");
  if (dom.hasWpBakeryMarkers) signals.push("wpbakery");
  if (dom.hasOxygenMarkers) signals.push("oxygen");
  if (dom.hasBricksMarkers) signals.push("bricks");
  if (dom.hasGutenbergBlocks) signals.push("gutenberg");
  return signals;
}

async function crawlSinglePage(
  page: PlaywrightPage,
  url: string,
  scanId: string,
  navTimeoutMs: number,
  runAxe: boolean
): Promise<CrawledPageData> {
  const empty: Omit<CrawledPageData, "requestedUrl" | "finalUrl" | "httpStatus" | "crawlStatus"> = {
    title: null,
    metaDescription: null,
    canonical: null,
    h1: null,
    h2: [],
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    images: [],
    forms: [],
    buttons: [],
    jsonLd: [],
    openGraph: {},
    scripts: [],
    screenshotPath: null,
    h1Count: 0,
    htmlLang: null,
    hasViewport: false,
    hasFavicon: false,
    hasCookieBannerMarkup: false,
    hasCtaAboveFold: false,
    hasLeadMagnet: false,
    hasDifferentiationLanguage: false,
    hasProofPoints: false,
    hasAudienceSpecificity: false,
    hasEsgSignals: false,
    hasHumanCenteredSignals: false,
    metaGenerator: null,
    metaRobots: null,
    contactLinks: [],
    headers: {},
    isWordPress: false,
    wordpressVersion: null,
    wordpressPlugins: [],
    wordpressTheme: null,
    hasWpContentPath: false,
    hasWpIncludesPath: false,
    wordpressCachingSignals: [],
    wordpressPageBuilderSignals: [],
    loadTimeMs: 0,
    redirectChainLength: 0,
    footerText: "",
    hasAuthorSignal: false,
    hasAddressSignal: false,
    hasTrustKeywords: false,
    hasFaqPattern: false,
    hasShortLeadParagraph: false,
    headingSequence: [],
    formFieldTotal: 0,
    formFieldLabelled: 0,
    linkTexts: [],
    axeViolations: null,
    axeError: null,
    navLinks: [],
    footerLinks: [],
  };

  try {
    const navStart = Date.now();
    const response = await page.goto(url, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
    const loadTimeMs = Date.now() - navStart;

    const httpStatus = response?.status() ?? null;
    const finalUrl = page.url();
    const headers = response?.headers() ?? {};
    const origin = new URL(url).origin;

    let redirectChainLength = 0;
    let redirectedRequest = response?.request().redirectedFrom() ?? null;
    while (redirectedRequest) {
      redirectChainLength++;
      redirectedRequest = redirectedRequest.redirectedFrom();
    }

    const dom = await extractDomData(page);
    const { internalLinks, externalLinks } = partitionLinks(dom.allLinks, origin);
    // Nav/footer links feed the crawl queue directly, so they need the same http(s)+same-origin
    // filtering as internalLinks — otherwise tel:/mailto: links (common in footers) get queued
    // as crawl candidates and Playwright fails trying to "navigate" to them.
    const navLinks = partitionLinks(dom.navLinks, origin).internalLinks;
    const footerLinks = partitionLinks(dom.footerLinks, origin).internalLinks;
    const screenshotPath = await captureScreenshot(page, scanId, url);
    const wp = detectWordPress(dom.metaGenerator, dom.assetSrcs);
    const axe = runAxe
      ? await runAxeAnalysis(page)
      : { violations: null, error: null };

    let crawlStatus: CrawlStatus = "success";
    if (httpStatus !== null && httpStatus >= 400) crawlStatus = "error";
    else if (finalUrl !== url) crawlStatus = "redirect";

    return {
      ...empty,
      requestedUrl: url,
      finalUrl,
      httpStatus,
      crawlStatus,
      title: dom.title,
      metaDescription: dom.metaDescription,
      canonical: dom.canonical,
      h1: dom.h1,
      h1Count: dom.h1Count,
      h2: dom.h2,
      wordCount: dom.wordCount,
      internalLinks,
      externalLinks,
      images: dom.images,
      forms: dom.forms,
      buttons: dom.buttons,
      jsonLd: dom.jsonLd,
      openGraph: dom.openGraph,
      scripts: dom.scripts,
      screenshotPath,
      htmlLang: dom.htmlLang,
      hasViewport: dom.hasViewport,
      hasFavicon: dom.hasFavicon,
      hasCookieBannerMarkup: dom.hasCookieBannerMarkup,
      hasCtaAboveFold: dom.hasCtaAboveFold,
      hasLeadMagnet: dom.hasLeadMagnet,
      hasDifferentiationLanguage: dom.hasDifferentiationLanguage,
      hasProofPoints: dom.hasProofPoints,
      hasAudienceSpecificity: dom.hasAudienceSpecificity,
      hasEsgSignals: dom.hasEsgSignals,
      hasHumanCenteredSignals: dom.hasHumanCenteredSignals,
      metaGenerator: dom.metaGenerator,
      metaRobots: dom.metaRobots,
      contactLinks: dom.contactLinks,
      headers,
      isWordPress: wp.isWordPress,
      wordpressVersion: wp.version,
      wordpressPlugins: wp.plugins,
      wordpressTheme: wp.theme,
      hasWpContentPath: wp.hasWpContentPath,
      hasWpIncludesPath: wp.hasWpIncludesPath,
      wordpressCachingSignals: detectCachingSignals(headers, wp.plugins),
      wordpressPageBuilderSignals: detectPageBuilderSignals(dom),
      loadTimeMs,
      redirectChainLength,
      footerText: dom.footerText,
      hasAuthorSignal: dom.hasAuthorSignal,
      hasAddressSignal: dom.hasAddressSignal,
      hasTrustKeywords: dom.hasTrustKeywords,
      hasFaqPattern: dom.hasFaqPattern,
      hasShortLeadParagraph: dom.hasShortLeadParagraph,
      headingSequence: dom.headingSequence,
      formFieldTotal: dom.formFieldTotal,
      formFieldLabelled: dom.formFieldLabelled,
      linkTexts: dom.linkTexts,
      axeViolations: axe.violations,
      axeError: axe.error,
      navLinks,
      footerLinks,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && /timeout/i.test(err.message);
    return {
      ...empty,
      requestedUrl: url,
      finalUrl: url,
      httpStatus: null,
      crawlStatus: isTimeout ? "timeout" : "error",
    };
  }
}

async function persistPage(scanId: string, data: CrawledPageData): Promise<void> {
  await prisma.page.create({
    data: {
      scanId,
      url: data.requestedUrl,
      finalUrl: data.finalUrl,
      httpStatus: data.httpStatus,
      crawlStatus: data.crawlStatus,
      rendered: true,
      title: data.title,
      metaDescription: data.metaDescription,
      canonical: data.canonical,
      h1: data.h1,
      h2: data.h2,
      wordCount: data.wordCount,
      internalLinks: data.internalLinks,
      externalLinks: data.externalLinks,
      images: data.images as unknown as Prisma.InputJsonValue,
      forms: data.forms as unknown as Prisma.InputJsonValue,
      buttons: data.buttons,
      jsonLd: data.jsonLd as unknown as Prisma.InputJsonValue,
      openGraph: data.openGraph as unknown as Prisma.InputJsonValue,
      scripts: data.scripts as unknown as Prisma.InputJsonValue,
      screenshotPath: data.screenshotPath,
    },
  });
}

function upsertCandidate(candidates: Map<string, Tier>, url: string, tier: Tier, visited: Set<string>) {
  if (visited.has(url)) return;
  const effectiveTier = isKeywordUrl(url) ? (Math.min(tier, TIER.keyword) as Tier) : tier;
  const existing = candidates.get(url);
  if (existing === undefined || effectiveTier < existing) {
    candidates.set(url, effectiveTier);
  }
}

function pickNextCandidate(candidates: Map<string, Tier>): string | null {
  let best: string | null = null;
  let bestTier = Infinity;
  for (const [url, tier] of candidates) {
    if (tier < bestTier) {
      best = url;
      bestTier = tier;
    }
  }
  return best;
}

export async function crawlWebsite({
  rootUrl,
  scanId,
  maxPages = 25,
  navTimeoutMs = NAV_TIMEOUT_MS,
  rateLimitDelayMs = RATE_LIMIT_DELAY_MS,
}: {
  rootUrl: string;
  scanId: string;
  maxPages?: number;
  navTimeoutMs?: number;
  rateLimitDelayMs?: number;
}): Promise<CrawlWebsiteResult> {
  const normalizedRoot = normalizeDomain(rootUrl);
  const origin = new URL(normalizedRoot).origin;
  const effectiveMaxPages = Math.min(maxPages, MAX_PAGES_HARD_CAP);

  const robots = await fetchRobots(origin);
  if (robots.disallowsAll) {
    return {
      blockedByRobots: true,
      robotsFound: robots.fetched,
      robotsTxtContent: robots.raw,
      sitemapFound: false,
      llmsTxtFound: false,
      pages: [],
      wordpressDiagnostics: null,
      httpsRedirectCheck: { httpReachable: false, finalUrl: null, redirectsToHttps: false },
    };
  }
  const sitemapUrls = await fetchSitemapUrls(origin);
  const llmsTxtFound = await fetchLlmsTxtPresence(origin);
  const httpsRedirectCheck = await fetchHttpsRedirectCheck(new URL(normalizedRoot).hostname);

  const visited = new Set<string>();
  const candidates = new Map<string, Tier>();
  candidates.set(normalizedRoot, TIER.homepage);
  for (const u of sitemapUrls) upsertCandidate(candidates, u, TIER.sitemap, visited);

  const pages: CrawledPageData[] = [];

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  try {
    // Explicit so "above the fold" (hasCtaAboveFold) has a well-defined, documented viewport
    // rather than depending on whatever Playwright's own default happens to be.
    const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 720 } });
    try {
      while (visited.size < effectiveMaxPages) {
        const next = pickNextCandidate(candidates);
        if (!next) break;
        candidates.delete(next);
        if (visited.has(next)) continue;
        visited.add(next);

        if (visited.size > 1) await sleep(rateLimitDelayMs);

        // The crawl order already follows the same nav/footer/keyword/sitemap tier
        // prioritization used elsewhere, so the homepage + first AXE_MAX_PRIORITY_PAGES pages
        // visited are the right sample for an axe-core accessibility scan.
        const runAxe = visited.size <= AXE_MAX_PRIORITY_PAGES + 1;

        const page = await context.newPage();
        let result: CrawledPageData;
        try {
          result = await crawlSinglePage(page, next, scanId, navTimeoutMs, runAxe);
        } finally {
          await page.close();
        }

        pages.push(result);
        await persistPage(scanId, result);

        if (result.crawlStatus === "success" || result.crawlStatus === "redirect") {
          for (const link of result.navLinks) upsertCandidate(candidates, link, TIER.nav, visited);
          for (const link of result.footerLinks)
            upsertCandidate(candidates, link, TIER.footer, visited);
          for (const link of result.internalLinks)
            upsertCandidate(candidates, link, TIER.discovered, visited);
        }
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const homepage = pages.find((p) => p.requestedUrl === normalizedRoot) ?? pages[0];
  const wordpressDiagnostics = homepage?.isWordPress
    ? await fetchWordPressDiagnostics(origin)
    : null;

  return {
    blockedByRobots: false,
    robotsFound: robots.fetched,
    robotsTxtContent: robots.raw,
    sitemapFound: sitemapUrls.length > 0,
    llmsTxtFound,
    pages,
    wordpressDiagnostics,
    httpsRedirectCheck,
  };
}
