import type { CrawlStatus } from "@/generated/prisma/enums";

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "FormistWiiBot/0.1 (+https://formist.studio/wii)";

export type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  crawlStatus: CrawlStatus;
  html: string | null;
  headers: Record<string, string>;
  fetchMs: number;
};

async function timedFetch(url: string, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    return { res, fetchMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPage(url: string): Promise<FetchedPage> {
  try {
    const { res, fetchMs } = await timedFetch(url);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => (headers[key] = value));

    let crawlStatus: CrawlStatus = "success";
    if (res.status >= 400) crawlStatus = "error";
    else if (res.redirected) crawlStatus = "redirect";

    const contentType = headers["content-type"] ?? "";
    const html = contentType.includes("text/html") ? await res.text() : null;

    return {
      requestedUrl: url,
      finalUrl: res.url,
      httpStatus: res.status,
      crawlStatus,
      html,
      headers,
      fetchMs,
    };
  } catch {
    return {
      requestedUrl: url,
      finalUrl: url,
      httpStatus: null,
      crawlStatus: "timeout",
      html: null,
      headers: {},
      fetchMs: FETCH_TIMEOUT_MS,
    };
  }
}

export type RobotsInfo = {
  fetched: boolean;
  disallowsAll: boolean;
  raw: string | null;
};

/** Minimal robots.txt parser: only checks whether the `*` group disallows the entire site. */
export async function fetchRobots(origin: string): Promise<RobotsInfo> {
  const page = await fetchPage(new URL("/robots.txt", origin).toString());
  if (page.httpStatus === null || page.httpStatus >= 400) {
    return { fetched: false, disallowsAll: false, raw: null };
  }
  const text = page.html ?? "";
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
  return { fetched: true, disallowsAll, raw: text };
}

export async function fetchSitemapPresence(origin: string): Promise<boolean> {
  const page = await fetchPage(new URL("/sitemap.xml", origin).toString());
  return page.httpStatus !== null && page.httpStatus < 400;
}

function extractAll(html: string, regex: RegExp): string[] {
  return [...html.matchAll(regex)].map((m) => m[1]);
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

export function extractMetaContent(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return m[1];
  // content before name/property (attribute order can vary)
  const reReversed = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`,
    "i"
  );
  const m2 = html.match(reReversed);
  return m2 ? m2[1] : null;
}

export function extractH1Count(html: string): number {
  return extractAll(html, /<h1[\s>]/gi).length;
}

export function extractCanonical(html: string): string | null {
  const m = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function extractImgAltCoverage(html: string): { total: number; withAlt: number } {
  const imgs = extractAll(html, /<img\s[^>]*>/gi);
  const withAlt = imgs.filter((tag) => /\salt=["'][^"']+["']/i.test(tag)).length;
  return { total: imgs.length, withAlt };
}

export function extractLinks(html: string, baseUrl: string): string[] {
  const hrefs = extractAll(html, /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>/gi);
  const base = new URL(baseUrl);
  const links = new Set<string>();
  for (const href of hrefs) {
    try {
      const resolved = new URL(href, base);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
      if (resolved.hostname !== base.hostname) continue;
      resolved.hash = "";
      links.add(resolved.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...links];
}

export function hasJsonLd(html: string): boolean {
  return /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
}

export function hasViewportMeta(html: string): boolean {
  return /<meta[^>]+name=["']viewport["']/i.test(html);
}

export function hasAnalyticsTag(html: string): boolean {
  return (
    /googletagmanager\.com\/gtm\.js/i.test(html) ||
    /gtag\(['"]config['"]/i.test(html) ||
    /G-[A-Z0-9]{6,}/.test(html) ||
    /UA-\d{4,}/.test(html)
  );
}

export function hasContactAffordance(html: string): boolean {
  return (
    /<form[\s>]/i.test(html) ||
    /href=["']mailto:/i.test(html) ||
    /href=["']tel:/i.test(html)
  );
}

export function detectWordPress(html: string): { isWordPress: boolean; version: string | null } {
  const generator = extractMetaContent(html, "generator");
  const versionFromGenerator = generator?.match(/WordPress\s*([\d.]+)/i)?.[1] ?? null;
  const isWordPress =
    Boolean(versionFromGenerator) ||
    /\/wp-content\//i.test(html) ||
    /\/wp-json\//i.test(html);
  return { isWordPress, version: versionFromGenerator };
}

export function detectPluginSlugs(html: string): string[] {
  const matches = extractAll(html, /\/wp-content\/plugins\/([a-z0-9-]+)\//gi);
  return [...new Set(matches)];
}

export function hasHtmlLangAttr(html: string): boolean {
  return /<html[^>]+lang=["'][a-z-]+["']/i.test(html);
}

export function extractFaviconPresence(html: string): boolean {
  return /<link[^>]+rel=["'](?:icon|shortcut icon)["']/i.test(html);
}
