import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import type { CrawledPageData } from "@/lib/crawler-service";
import { isCrawlOk, isHomepage } from "./types";

/**
 * WordPress maintainability: only emitted once, from the homepage, when WordPress is detected —
 * otherwise every crawled page would report near-duplicate "WordPress detected" findings, and a
 * non-WordPress site would incorrectly get a wordpress_maintainability score at all (its weight
 * is redistributed across the other 9 categories instead — see lib/scoring.ts).
 *
 * Every check here is either (a) parsed from public page markup already captured by the crawler,
 * or (b) a single passive, unauthenticated GET to a publicly reachable URL performed once per
 * scan by lib/crawler-service.ts's fetchWordPressDiagnostics(). Per the task constraints: no
 * intrusive security testing, no login attempts, no exploitation — only publicly visible signals.
 */
export const extractWordPress: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page) || !isHomepage(scan, page) || !page.isWordPress) return [];

  const diagnostics = scan.wordpressDiagnostics;
  const items: NormalizedEvidence[] = [];

  items.push(checkGeneratorMetaTag(page));
  items.push(checkWpContentPath(page));
  items.push(checkWpIncludesPath(page));
  items.push(checkThemePath(page));
  items.push(checkPluginPaths(page));
  items.push(checkCachingPluginSignals(page));
  items.push(checkPageBuilderSignals(page));
  items.push(checkOutdatedGeneratorVersion(page, diagnostics));

  if (diagnostics?.attempted) {
    items.push(checkWpJsonAvailability(page, diagnostics));
    items.push(checkWpRestUserEnumeration(page, diagnostics));
    items.push(checkXmlrpcAvailability(page, diagnostics));
    items.push(checkLoginPathBehavior(page, diagnostics));
  }

  return items;
};

function checkGeneratorMetaTag(page: CrawledPageData): NormalizedEvidence {
  const disclosed = Boolean(page.wordpressVersion);
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "generator_meta_tag",
    severity: disclosed ? "minor" : "info",
    finding: disclosed
      ? `The generator meta tag publicly discloses WordPress core version ${page.wordpressVersion}.`
      : "WordPress was detected but no version-disclosing generator meta tag was found on the homepage.",
    rawData: { disclosed, version: page.wordpressVersion },
    confidence: 1,
    recommendationText: disclosed
      ? "Remove or strip the generator meta tag so the exact core version isn't advertised to automated scanners."
      : null,
  };
}

function checkWpContentPath(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "wp_content_path",
    severity: "info",
    finding: page.hasWpContentPath
      ? "A /wp-content/ asset path was found in the homepage markup, confirming a WordPress installation."
      : "No /wp-content/ asset path was found on the homepage (WordPress was detected via other signals).",
    rawData: { detected: page.hasWpContentPath },
    confidence: 1,
    recommendationText: null,
  };
}

function checkWpIncludesPath(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "wp_includes_path",
    severity: "info",
    finding: page.hasWpIncludesPath
      ? "A /wp-includes/ asset path was found in the homepage markup."
      : "No /wp-includes/ asset path was found on the homepage (core assets may be proxied, minified, or bundled).",
    rawData: { detected: page.hasWpIncludesPath },
    confidence: page.hasWpIncludesPath ? 1 : 0.6,
    recommendationText: null,
  };
}

function checkThemePath(page: CrawledPageData): NormalizedEvidence {
  const found = Boolean(page.wordpressTheme);
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "theme_path",
    severity: "info",
    finding: found
      ? `Active theme slug "${page.wordpressTheme}" is visible via a /wp-content/themes/ asset path.`
      : "not detected — no /wp-content/themes/ asset path was visible on the homepage (theme may be renamed or its assets proxied).",
    rawData: { theme: page.wordpressTheme },
    confidence: found ? 1 : 0.5,
    recommendationText: null,
  };
}

function checkPluginPaths(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "plugin_paths",
    severity: "info",
    finding: `${page.wordpressPlugins.length} plugin(s) detectable from public /wp-content/plugins/ asset paths on the homepage.`,
    rawData: { plugins: page.wordpressPlugins },
    // Only catches plugins referenced via public asset URLs on this page — not a full inventory.
    confidence: 0.75,
    recommendationText: null,
  };
}

function checkCachingPluginSignals(page: CrawledPageData): NormalizedEvidence {
  const detected = page.wordpressCachingSignals;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "caching_plugin_signals",
    severity: "info",
    finding:
      detected.length > 0
        ? `Caching signal(s) detected: ${detected.join(", ")}.`
        : "not detected — no known caching plugin asset paths or cache-related response headers were found.",
    rawData: { signals: detected },
    // Heuristic: known plugin slugs and a fixed header list, not exhaustive.
    confidence: detected.length > 0 ? 0.8 : 0.5,
    recommendationText:
      detected.length === 0
        ? "Consider adding page/object caching (e.g. a caching plugin or server-level cache) to improve performance and resilience under load."
        : null,
  };
}

function checkPageBuilderSignals(page: CrawledPageData): NormalizedEvidence {
  const detected = page.wordpressPageBuilderSignals;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "page_builder_signals",
    severity: "info",
    finding:
      detected.length > 0
        ? `Page builder signal(s) detected: ${detected.join(", ")}.`
        : "not detected — no known page-builder (Elementor, Divi, WPBakery, Oxygen, Bricks) or Gutenberg block markup was found.",
    rawData: { signals: detected },
    confidence: 0.8,
    recommendationText: null,
  };
}

function checkOutdatedGeneratorVersion(
  page: CrawledPageData,
  diagnostics: ScanContext["wordpressDiagnostics"]
): NormalizedEvidence {
  const disclosedVersion = page.wordpressVersion;
  const latestVersion = diagnostics?.latestCoreVersion ?? null;

  if (!disclosedVersion) {
    return {
      url: page.requestedUrl,
      category: "wordpress_maintainability",
      source: "outdated_generator_version",
      severity: "info",
      finding:
        "not detected — no WordPress core version is publicly disclosed, so currency could not be assessed.",
      rawData: { disclosedVersion: null, latestVersion },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  if (!latestVersion) {
    return {
      url: page.requestedUrl,
      category: "wordpress_maintainability",
      source: "outdated_generator_version",
      severity: "info",
      finding: `not detected — WordPress core version ${disclosedVersion} is disclosed, but the current release could not be looked up to compare against.`,
      rawData: { disclosedVersion, latestVersion: null },
      confidence: 0.4,
      recommendationText: null,
    };
  }

  const comparison = compareVersions(disclosedVersion, latestVersion);
  const outdated = comparison < 0;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "outdated_generator_version",
    severity: outdated ? "moderate" : "info",
    finding: outdated
      ? `Disclosed WordPress core version ${disclosedVersion} is behind the current release (${latestVersion}).`
      : `Disclosed WordPress core version ${disclosedVersion} matches the current release (${latestVersion}).`,
    rawData: { disclosedVersion, latestVersion, outdated },
    confidence: 0.9,
    recommendationText: outdated
      ? "Update WordPress core to the latest version to receive security fixes and maintain compatibility."
      : null,
  };
}

function checkWpJsonAvailability(
  page: CrawledPageData,
  diagnostics: NonNullable<ScanContext["wordpressDiagnostics"]>
): NormalizedEvidence {
  const reachable = diagnostics.wpJson.reachable;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "wp_json_availability",
    severity: "info",
    finding: reachable
      ? `The WordPress REST API root (/wp-json/) is publicly reachable (HTTP ${diagnostics.wpJson.status}).`
      : `The WordPress REST API root (/wp-json/) was not reachable (HTTP ${diagnostics.wpJson.status ?? "no response"}), suggesting it is disabled or blocked.`,
    rawData: diagnostics.wpJson,
    confidence: 1,
    recommendationText: null,
  };
}

function checkWpRestUserEnumeration(
  page: CrawledPageData,
  diagnostics: NonNullable<ScanContext["wordpressDiagnostics"]>
): NormalizedEvidence {
  const { reachable, userCount } = diagnostics.restUsersEndpoint;
  const exposesUsers = reachable && (userCount ?? 0) > 0;

  if (exposesUsers) {
    return {
      url: page.requestedUrl,
      category: "wordpress_maintainability",
      source: "wp_rest_user_enumeration",
      severity: "major",
      finding: `The default WordPress REST API user endpoint (/wp-json/wp/v2/users) publicly returns ${userCount} user record(s), enabling username enumeration.`,
      rawData: diagnostics.restUsersEndpoint,
      confidence: 1,
      recommendationText:
        "Restrict or disable the /wp-json/wp/v2/users REST endpoint (via a security plugin or code snippet) to prevent public username enumeration.",
    };
  }

  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "wp_rest_user_enumeration",
    severity: "info",
    finding: reachable
      ? "The /wp-json/wp/v2/users endpoint is reachable but did not return an enumerable user list."
      : "The /wp-json/wp/v2/users endpoint is not publicly reachable — user enumeration via the default REST API appears blocked.",
    rawData: diagnostics.restUsersEndpoint,
    confidence: 0.9,
    recommendationText: null,
  };
}

function checkXmlrpcAvailability(
  page: CrawledPageData,
  diagnostics: NonNullable<ScanContext["wordpressDiagnostics"]>
): NormalizedEvidence {
  const { reachable, status } = diagnostics.xmlrpc;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "xmlrpc_availability",
    severity: reachable ? "moderate" : "info",
    finding: reachable
      ? `xmlrpc.php is publicly reachable (HTTP ${status}), which increases exposure to brute-force and pingback-amplification abuse.`
      : `xmlrpc.php was not reachable (HTTP ${status ?? "no response"}), suggesting it is disabled or blocked.`,
    rawData: diagnostics.xmlrpc,
    confidence: 0.9,
    recommendationText: reachable
      ? "Disable XML-RPC (via hosting config or a security plugin) unless a specific integration requires it."
      : null,
  };
}

function checkLoginPathBehavior(
  page: CrawledPageData,
  diagnostics: NonNullable<ScanContext["wordpressDiagnostics"]>
): NormalizedEvidence {
  const { reachable, status, looksLikeWpLogin } = diagnostics.loginPage;
  // Read-only: this only loads the login page to observe its markup. No credentials were
  // submitted and no login was attempted.
  const defaultLoginExposed = reachable && looksLikeWpLogin;
  return {
    url: page.requestedUrl,
    category: "wordpress_maintainability",
    source: "login_path_behavior",
    severity: defaultLoginExposed ? "minor" : "info",
    finding: defaultLoginExposed
      ? `The default wp-login.php path is publicly reachable and renders the standard login form (HTTP ${status}). No credentials were submitted.`
      : `The default wp-login.php path did not render a standard WordPress login form (HTTP ${status ?? "no response"}), suggesting it is renamed, restricted, or protected.`,
    rawData: diagnostics.loginPage,
    confidence: 0.85,
    recommendationText: defaultLoginExposed
      ? "Consider renaming or restricting access to the default login path and adding rate limiting / MFA to reduce automated credential-stuffing exposure."
      : null,
  };
}

/** Compares two dotted-numeric version strings. Returns <0 if a<b, 0 if equal, >0 if a>b. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
