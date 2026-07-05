import type { CrawledPageData } from "@/lib/crawler-service";
import type { EvidenceExtractor, NormalizedEvidence, ScanContext } from "./types";
import { isCrawlOk, isHomepage } from "./types";

/**
 * AI discoverability: how easily AI systems and answer engines can identify, parse, and trust
 * this site's content — structured data, entity signals, crawlable text, and llms.txt/robots.txt
 * treatment of known AI crawlers.
 *
 * Several checks here are inherently uncertain (schema "where relevant", entity consistency,
 * trust signals, answer-like content) — per instruction, these report a neutral "not detected"
 * finding with reduced confidence rather than asserting a failure we can't actually confirm.
 * Deterministic facts (schema presence via parsed JSON-LD, word counts, HTTP fetches) use
 * confidence 1.
 */
const ABOUT_PATTERN = /about/i;
const SERVICE_PATTERN = /service|offer/i;
const PROOF_PATTERN = /testimonial|case-stud|portfolio|review|client|success-stor/i;
const CONTACT_PATTERN = /contact/i;

const KNOWN_AI_CRAWLERS = [
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "google-extended",
  "ccbot",
  "anthropic-ai",
  "claudebot",
  "claude-web",
  "claude-searchbot",
  "perplexitybot",
  "bytespider",
  "amazonbot",
  "applebot-extended",
  "cohere-ai",
  "diffbot",
  "facebookbot",
  "meta-externalagent",
  "omgilibot",
  "youbot",
];

export const extractAiDiscoverability: EvidenceExtractor = (scan, page) => {
  if (!isCrawlOk(page)) return [];

  const items: NormalizedEvidence[] = [];
  const schemaNodes = flattenSchemaNodes(page.jsonLd);

  items.push(checkOrganizationSchema(schemaNodes, page));
  items.push(checkLocalBusinessSchema(schemaNodes, page));
  items.push(...checkServiceSchema(schemaNodes, page));
  items.push(...checkProductSchema(schemaNodes, page));
  items.push(...checkFaqSchema(schemaNodes, page));
  items.push(...checkArticleSchema(schemaNodes, page));
  items.push(checkBreadcrumbSchema(schemaNodes, page, scan));
  items.push(checkFaqContent(page));
  items.push(checkAnswerLikeContent(page));
  items.push(checkTrustSignals(page));
  items.push(checkCrawlableTextRatio(page));
  items.push(checkOpenGraph(page));

  if (isHomepage(scan, page)) {
    items.push(checkEntityConsistency(schemaNodes, scan));
    items.push(...checkClearAboutPage(scan));
    items.push(...checkClearServicePages(scan));
    items.push(checkLlmsTxt(scan));
    items.push(checkAiCrawlerRobotsTreatment(scan));
    items.push(checkInternalLinkingCompleteness(scan));
  }

  return items;
};

// --- schema.org JSON-LD helpers ---

type SchemaNode = Record<string, unknown>;

function flattenSchemaNodes(jsonLd: unknown[]): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as SchemaNode;
      nodes.push(obj);
      if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
    }
  };
  jsonLd.forEach(visit);
  return nodes;
}

function getSchemaTypes(node: SchemaNode): string[] {
  const type = node["@type"];
  if (typeof type === "string") return [type.toLowerCase()];
  if (Array.isArray(type)) {
    return type.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
  }
  return [];
}

function hasSchemaType(nodes: SchemaNode[], typeNames: string[]): boolean {
  const wanted = typeNames.map((t) => t.toLowerCase());
  return nodes.some((n) => getSchemaTypes(n).some((t) => wanted.includes(t)));
}

function findOrganizationName(nodes: SchemaNode[]): string | null {
  const org = nodes.find((n) => getSchemaTypes(n).includes("organization"));
  const name = org?.name;
  return typeof name === "string" ? name : null;
}

// --- per-page checks ---

function checkOrganizationSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence {
  const present = hasSchemaType(nodes, ["Organization", "Corporation", "LocalBusiness"]);
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "organization_schema",
    severity: present ? "info" : "moderate",
    finding: present ? "Organization (or subtype) schema was found." : "No Organization schema was found.",
    rawData: { present },
    confidence: 1,
    recommendationText: present
      ? null
      : "Add Organization schema (schema.org/Organization) with name, url, and logo so AI systems can identify this business as a distinct entity.",
  };
}

function checkLocalBusinessSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence {
  const present = hasSchemaType(nodes, [
    "LocalBusiness",
    "Restaurant",
    "Store",
    "ProfessionalService",
    "HomeAndConstructionBusiness",
  ]);
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "local_business_schema",
    severity: "info",
    finding: present
      ? "LocalBusiness (or subtype) schema was found."
      : "not detected — no LocalBusiness schema was found (relevance to this business could not be confirmed).",
    rawData: { present },
    confidence: present ? 1 : 0.5,
    recommendationText: present
      ? null
      : "If this is a local or physical-location business, add LocalBusiness schema with address and hours.",
  };
}

function checkServiceSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence[] {
  const present = hasSchemaType(nodes, ["Service"]);
  if (present) {
    return [
      {
        url: page.requestedUrl,
        category: "ai_discoverability",
        source: "service_schema",
        severity: "info",
        finding: "Service schema was found.",
        rawData: { present: true },
        confidence: 1,
        recommendationText: null,
      },
    ];
  }
  if (!SERVICE_PATTERN.test(new URL(page.requestedUrl).pathname)) return [];
  return [
    {
      url: page.requestedUrl,
      category: "ai_discoverability",
      source: "service_schema",
      severity: "moderate",
      finding: "This page appears to describe a service or offering but has no Service schema.",
      rawData: { present: false },
      confidence: 0.7,
      recommendationText: "Add Service schema (schema.org/Service) describing what's offered.",
    },
  ];
}

function checkProductSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence[] {
  const present = hasSchemaType(nodes, ["Product"]);
  if (present) {
    return [
      {
        url: page.requestedUrl,
        category: "ai_discoverability",
        source: "product_schema",
        severity: "info",
        finding: "Product schema was found.",
        rawData: { present: true },
        confidence: 1,
        recommendationText: null,
      },
    ];
  }
  if (!/pricing|shop|store|product/i.test(new URL(page.requestedUrl).pathname)) return [];
  return [
    {
      url: page.requestedUrl,
      category: "ai_discoverability",
      source: "product_schema",
      severity: "moderate",
      finding: "This page appears to be product/pricing related but has no Product schema.",
      rawData: { present: false },
      confidence: 0.6,
      recommendationText: "Add Product schema if this page describes a purchasable product or package.",
    },
  ];
}

function checkFaqSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence[] {
  const present = hasSchemaType(nodes, ["FAQPage"]);
  if (present) {
    return [
      {
        url: page.requestedUrl,
        category: "ai_discoverability",
        source: "faq_schema",
        severity: "info",
        finding: "FAQPage schema was found.",
        rawData: { present: true },
        confidence: 1,
        recommendationText: null,
      },
    ];
  }
  if (!page.hasFaqPattern) return [];
  return [
    {
      url: page.requestedUrl,
      category: "ai_discoverability",
      source: "faq_schema",
      severity: "moderate",
      finding: "Page has FAQ-like content (Q&A headings or expandable sections) but no FAQPage schema.",
      rawData: { present: false, hasFaqPattern: true },
      confidence: 0.75,
      recommendationText:
        "Mark up existing FAQ content with FAQPage schema so answer engines can extract Q&A pairs directly.",
    },
  ];
}

function checkArticleSchema(nodes: SchemaNode[], page: CrawledPageData): NormalizedEvidence[] {
  const present = hasSchemaType(nodes, ["Article", "BlogPosting", "NewsArticle"]);
  if (present) {
    return [
      {
        url: page.requestedUrl,
        category: "ai_discoverability",
        source: "article_schema",
        severity: "info",
        finding: "Article/BlogPosting schema was found.",
        rawData: { present: true },
        confidence: 1,
        recommendationText: null,
      },
    ];
  }
  const looksLikeArticle = /blog/i.test(new URL(page.requestedUrl).pathname) && page.wordCount > 300;
  if (!looksLikeArticle) return [];
  return [
    {
      url: page.requestedUrl,
      category: "ai_discoverability",
      source: "article_schema",
      severity: "moderate",
      finding: `Page looks like an article (${page.wordCount} words on a blog path) but has no Article schema.`,
      rawData: { present: false, wordCount: page.wordCount },
      confidence: 0.65,
      recommendationText: "Add Article or BlogPosting schema with headline, author, and datePublished.",
    },
  ];
}

function checkBreadcrumbSchema(
  nodes: SchemaNode[],
  page: CrawledPageData,
  scan: ScanContext
): NormalizedEvidence {
  const present = hasSchemaType(nodes, ["BreadcrumbList"]);
  if (isHomepage(scan, page)) {
    return {
      url: page.requestedUrl,
      category: "ai_discoverability",
      source: "breadcrumb_schema",
      severity: "info",
      finding: present
        ? "BreadcrumbList schema was found."
        : "No BreadcrumbList schema on the homepage (not typically needed here).",
      rawData: { present },
      confidence: 1,
      recommendationText: null,
    };
  }
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "breadcrumb_schema",
    severity: present ? "info" : "minor",
    finding: present ? "BreadcrumbList schema was found." : "No BreadcrumbList schema was found on this page.",
    rawData: { present },
    confidence: 1,
    recommendationText: present
      ? null
      : "Add BreadcrumbList schema to help AI systems understand this page's place in the site structure.",
  };
}

function checkFaqContent(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "faq_content",
    severity: "info",
    finding: page.hasFaqPattern
      ? "Page includes FAQ-style content (Q&A headings or expandable sections)."
      : "No FAQ-style content was detected on this page.",
    rawData: { hasFaqPattern: page.hasFaqPattern },
    confidence: 0.7,
    recommendationText: null,
  };
}

function checkAnswerLikeContent(page: CrawledPageData): NormalizedEvidence {
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "answer_like_content",
    severity: page.hasShortLeadParagraph ? "info" : "moderate",
    finding: page.hasShortLeadParagraph
      ? "Page has a concise lead paragraph that could serve as an extractable answer snippet."
      : "No concise lead paragraph was detected near the top of the page.",
    rawData: { hasShortLeadParagraph: page.hasShortLeadParagraph },
    confidence: 0.6,
    recommendationText: page.hasShortLeadParagraph
      ? null
      : "Add a short, direct summary paragraph (roughly 40-300 characters) near the top of the page that answer engines can extract as a snippet.",
  };
}

function checkTrustSignals(page: CrawledPageData): NormalizedEvidence {
  const hasPhone = page.contactLinks.some((l) => l.toLowerCase().startsWith("tel:"));
  const signals = {
    author: page.hasAuthorSignal,
    address: page.hasAddressSignal,
    phone: hasPhone,
    credentials: page.hasTrustKeywords,
  };
  const detected = Object.entries(signals)
    .filter(([, present]) => present)
    .map(([name]) => name);
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "trust_signals",
    severity: detected.length === 0 ? "moderate" : "info",
    finding:
      detected.length > 0
        ? `Detected trust signal(s): ${detected.join(", ")}.`
        : "not detected — no author, address, phone, or credential/trust keyword signals were found on this page.",
    rawData: signals,
    confidence: 0.6,
    recommendationText:
      detected.length === 0
        ? "Add visible author/team info, location, credentials, or trust indicators (certifications, years in business, testimonials) so AI systems and users can verify legitimacy."
        : null,
  };
}

function checkCrawlableTextRatio(page: CrawledPageData): NormalizedEvidence {
  const veryThin = page.wordCount < 20;
  const imageHeavy = !veryThin && page.wordCount < 50 && page.images.length > 3;
  const severity = veryThin ? "major" : imageHeavy ? "moderate" : "info";
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "crawlable_text_ratio",
    severity,
    finding: veryThin
      ? `Page has very little crawlable text (${page.wordCount} words).`
      : imageHeavy
        ? `Page is image-heavy with limited crawlable text (${page.wordCount} words, ${page.images.length} images).`
        : `Page has ${page.wordCount} words of crawlable text.`,
    rawData: { wordCount: page.wordCount, imageCount: page.images.length },
    confidence: 1,
    recommendationText:
      severity === "info"
        ? null
        : "Add substantive crawlable text content — AI systems and search engines can't reliably extract meaning from image-only content.",
  };
}

function checkOpenGraph(page: CrawledPageData): NormalizedEvidence {
  const hasOg = Boolean(page.openGraph["og:title"] || page.openGraph["og:description"]);
  return {
    url: page.requestedUrl,
    category: "ai_discoverability",
    source: "open_graph_tags",
    severity: hasOg ? "info" : "minor",
    finding: hasOg
      ? "Page declares Open Graph title/description tags."
      : "No Open Graph title/description tags were found.",
    rawData: { present: hasOg, tags: Object.keys(page.openGraph) },
    confidence: 1,
    recommendationText: hasOg
      ? null
      : "Add Open Graph title/description tags so AI assistants and social platforms can summarize this page accurately.",
  };
}

// --- site-level checks (homepage call only) ---

function checkEntityConsistency(nodes: SchemaNode[], scan: ScanContext): NormalizedEvidence {
  const orgName = findOrganizationName(nodes);
  const homepage = scan.allPages.find((p) => p.requestedUrl === scan.homepageUrl);
  if (!orgName || !homepage) {
    return {
      url: scan.homepageUrl,
      category: "ai_discoverability",
      source: "entity_consistency",
      severity: "info",
      finding: "not detected — no Organization schema name was found to check entity consistency against.",
      rawData: { orgName: null },
      confidence: 0.3,
      recommendationText:
        "Add Organization schema with a name field so brand identity can be verified consistently across the site.",
    };
  }

  const needle = orgName.toLowerCase();
  const inTitle = (homepage.title ?? "").toLowerCase().includes(needle);
  const inH1 = (homepage.h1 ?? "").toLowerCase().includes(needle);
  const inFooter = homepage.footerText.toLowerCase().includes(needle);
  const matches = [inTitle, inH1, inFooter].filter(Boolean).length;
  const consistent = matches >= 2;

  return {
    url: scan.homepageUrl,
    category: "ai_discoverability",
    source: "entity_consistency",
    severity: consistent ? "info" : "moderate",
    finding: consistent
      ? `Organization name "${orgName}" is consistently referenced across title/H1/footer (${matches}/3 surfaces).`
      : `Organization name "${orgName}" from schema was found on only ${matches}/3 of title/H1/footer.`,
    rawData: { orgName, inTitle, inH1, inFooter },
    confidence: 0.75,
    recommendationText: consistent
      ? null
      : "Make sure the brand/entity name from Organization schema also appears in the page title, H1, and footer for consistent entity signals.",
  };
}

function checkClearAboutPage(scan: ScanContext): NormalizedEvidence[] {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  const aboutPages = successfulPages.filter((p) => ABOUT_PATTERN.test(new URL(p.requestedUrl).pathname));

  if (aboutPages.length === 0) {
    return [
      {
        url: null,
        category: "ai_discoverability",
        source: "clear_about_page",
        severity: "moderate",
        finding: "not detected — no About page was found among crawled pages.",
        rawData: { found: false },
        confidence: 0.7,
        recommendationText:
          "Add a clear About page describing who runs this business — AI systems use this to establish entity trust.",
      },
    ];
  }

  const bestPage = aboutPages.reduce((a, b) => (a.wordCount >= b.wordCount ? a : b));
  const thin = bestPage.wordCount < 100;
  return [
    {
      url: bestPage.requestedUrl,
      category: "ai_discoverability",
      source: "clear_about_page",
      severity: thin ? "moderate" : "info",
      finding: thin
        ? `An About page was found but has very little content (${bestPage.wordCount} words).`
        : `A clear About page was found with substantive content (${bestPage.wordCount} words).`,
      rawData: { found: true, wordCount: bestPage.wordCount },
      confidence: 0.8,
      recommendationText: thin
        ? "Expand the About page with real detail about the business, team, and mission."
        : null,
    },
  ];
}

function checkClearServicePages(scan: ScanContext): NormalizedEvidence[] {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  const servicePages = successfulPages.filter((p) => SERVICE_PATTERN.test(new URL(p.requestedUrl).pathname));

  if (servicePages.length === 0) {
    return [
      {
        url: null,
        category: "ai_discoverability",
        source: "clear_service_pages",
        severity: "moderate",
        finding: "not detected — no dedicated service/offering pages were found among crawled pages.",
        rawData: { found: false, count: 0 },
        confidence: 0.7,
        recommendationText:
          "Add dedicated pages describing each service or offering so AI systems can match user queries to what you provide.",
      },
    ];
  }

  const thinCount = servicePages.filter((p) => p.wordCount < 100).length;
  return [
    {
      url: null,
      category: "ai_discoverability",
      source: "clear_service_pages",
      severity: thinCount === servicePages.length ? "moderate" : "info",
      finding: `${servicePages.length} service/offering page(s) found; ${thinCount} have very little content.`,
      rawData: { found: true, count: servicePages.length, thinCount },
      confidence: 0.75,
      recommendationText:
        thinCount > 0 ? "Expand thin service pages with concrete detail about what's offered." : null,
    },
  ];
}

function checkLlmsTxt(scan: ScanContext): NormalizedEvidence {
  return {
    url: null,
    category: "ai_discoverability",
    source: "llms_txt",
    severity: scan.llmsTxtFound ? "info" : "minor",
    finding: scan.llmsTxtFound
      ? "llms.txt was found at the site root."
      : "No llms.txt file was found at the site root.",
    rawData: { present: scan.llmsTxtFound },
    confidence: 1,
    recommendationText: scan.llmsTxtFound
      ? null
      : "Consider publishing an llms.txt file summarizing the site for AI assistants (an emerging, optional convention).",
  };
}

function checkAiCrawlerRobotsTreatment(scan: ScanContext): NormalizedEvidence {
  if (!scan.robotsTxtContent) {
    return {
      url: null,
      category: "ai_discoverability",
      source: "ai_crawler_access",
      severity: "info",
      finding: "not detected — no robots.txt content was available to check for AI-crawler-specific rules.",
      rawData: { checked: false },
      confidence: 0.3,
      recommendationText: null,
    };
  }

  const blocked = getBlockedAiCrawlers(scan.robotsTxtContent);
  return {
    url: null,
    category: "ai_discoverability",
    source: "ai_crawler_access",
    severity: blocked.length > 0 ? "moderate" : "info",
    finding:
      blocked.length > 0
        ? `robots.txt explicitly blocks ${blocked.length} known AI crawler(s): ${blocked.join(", ")}.`
        : "robots.txt does not explicitly block any known AI crawlers.",
    rawData: { blocked },
    // Simple per-user-agent-group parsing, not a full robots.txt spec implementation.
    confidence: 0.85,
    recommendationText:
      blocked.length > 0
        ? "Confirm blocking these AI crawlers is intentional — it will reduce discoverability by AI assistants and answer engines."
        : null,
  };
}

function getBlockedAiCrawlers(robotsTxt: string): string[] {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.trim());
  const blocked: string[] = [];
  let currentAgent: string | null = null;
  let currentDisallowsAll = false;

  const flush = () => {
    if (currentAgent && currentDisallowsAll && KNOWN_AI_CRAWLERS.includes(currentAgent.toLowerCase())) {
      blocked.push(currentAgent);
    }
  };

  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key)) {
      flush();
      currentAgent = value;
      currentDisallowsAll = false;
    } else if (/^disallow$/i.test(key) && value === "/") {
      currentDisallowsAll = true;
    }
  }
  flush();

  return blocked;
}

function classifyLinkKind(url: string): "service" | "proof" | "contact" | null {
  const path = new URL(url).pathname;
  if (CONTACT_PATTERN.test(path)) return "contact";
  if (PROOF_PATTERN.test(path)) return "proof";
  if (SERVICE_PATTERN.test(path)) return "service";
  return null;
}

function checkInternalLinkingCompleteness(scan: ScanContext): NormalizedEvidence {
  const successfulPages = scan.allPages.filter(isCrawlOk);
  const byKind: Record<"service" | "proof" | "contact", CrawledPageData[]> = {
    service: [],
    proof: [],
    contact: [],
  };
  for (const p of successfulPages) {
    const kind = classifyLinkKind(p.requestedUrl);
    if (kind) byKind[kind].push(p);
  }

  const kinds = ["service", "proof", "contact"] as const;
  const missingKinds = kinds.filter((k) => byKind[k].length === 0);

  const linkedKinds = new Set<string>();
  for (const p of successfulPages) {
    for (const link of p.internalLinks) {
      const kind = classifyLinkKind(link);
      if (kind) linkedKinds.add(kind);
    }
  }
  const unlinkedButPresent = kinds.filter((k) => byKind[k].length > 0 && !linkedKinds.has(k));

  const issues = [
    ...missingKinds.map((k) => `no ${k} page found`),
    ...unlinkedButPresent.map((k) => `${k} page(s) exist but nothing links to them`),
  ];

  return {
    url: null,
    category: "ai_discoverability",
    source: "internal_linking_completeness",
    severity: issues.length > 0 ? "moderate" : "info",
    finding:
      issues.length > 0
        ? `Internal linking gaps: ${issues.join("; ")}.`
        : "Service, proof, and contact paths are present and internally linked.",
    rawData: {
      missingKinds,
      unlinkedButPresent,
      counts: { service: byKind.service.length, proof: byKind.proof.length, contact: byKind.contact.length },
    },
    // Only reflects the crawled sample (up to 25 pages) and simple path-keyword classification.
    confidence: 0.6,
    recommendationText:
      issues.length > 0
        ? "Make sure services, proof (testimonials/case studies), and contact are all present and cross-linked so users and AI systems can navigate the full conversion path."
        : null,
  };
}
