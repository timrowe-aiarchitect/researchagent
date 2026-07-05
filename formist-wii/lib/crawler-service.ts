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
  hasAnalyticsTag: boolean;
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
  // Consumed only by the crawl-queue prioritization in crawlWebsite(), not persisted.
  navLinks: string[];
  footerLinks: string[];
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
          snippet: !src ? (s.textContent || "").slice(0, 300) : null,
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
    };
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function detectAnalyticsTag(scripts: ScriptCapture[]): boolean {
  return scripts.some((s) => {
    const haystack = `${s.src ?? ""} ${s.snippet ?? ""}`;
    return (
      /googletagmanager\.com\/gtm\.js/i.test(haystack) ||
      /gtag\(['"]config['"]/i.test(haystack) ||
      /G-[A-Z0-9]{6,}/.test(haystack) ||
      /UA-\d{4,}/.test(haystack)
    );
  });
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
  navTimeoutMs: number
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
    hasAnalyticsTag: false,
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
      hasAnalyticsTag: detectAnalyticsTag(dom.scripts),
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
    };
  }
  const sitemapUrls = await fetchSitemapUrls(origin);
  const llmsTxtFound = await fetchLlmsTxtPresence(origin);

  const visited = new Set<string>();
  const candidates = new Map<string, Tier>();
  candidates.set(normalizedRoot, TIER.homepage);
  for (const u of sitemapUrls) upsertCandidate(candidates, u, TIER.sitemap, visited);

  const pages: CrawledPageData[] = [];

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    try {
      while (visited.size < effectiveMaxPages) {
        const next = pickNextCandidate(candidates);
        if (!next) break;
        candidates.delete(next);
        if (visited.has(next)) continue;
        visited.add(next);

        if (visited.size > 1) await sleep(rateLimitDelayMs);

        const page = await context.newPage();
        let result: CrawledPageData;
        try {
          result = await crawlSinglePage(page, next, scanId, navTimeoutMs);
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
  };
}
