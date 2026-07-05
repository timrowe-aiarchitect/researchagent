# PRD: Website Intelligence Index (WII) — MVP

**Owner:** Formist Studio (internal tool)
**Status:** Draft v1.0
**Last updated:** 2026-07-05

## 1. Summary

Website Intelligence Index (WII) is an internal Formist Studio application that accepts a public website URL and produces a Website Intelligence Index Report: a single scored, evidence-backed assessment of a website's technical SEO, on-page SEO, AI discoverability, performance, accessibility, security, analytics, WordPress maintainability, brand experience, and conversion readiness. The report is designed to be used directly in client conversations — as a diagnostic sales tool, an onboarding artifact, and a benchmark for measuring engagement impact over time.

## 2. Problem & Motivation

Formist Studio account leads and strategists currently assemble ad-hoc audits (manual Lighthouse runs, screaming frog exports, gut-feel notes) before client pitches and QBRs. This is slow, inconsistent across staff, hard to defend with evidence, and produces no lasting baseline to show improvement. We need one command — "run WII on this URL" — that returns a defensible, presentable score with evidence and a next-steps roadmap, in a format that can go straight into a client deck.

## 3. Goals

- Produce a single, explainable **0–100 WII score** and letter **grade** for any public website within minutes of URL submission.
- Back every score with concrete, citable **evidence** (the specific pages/values observed), not a black box.
- Translate findings into a **prioritized roadmap** and **client-ready language** non-technical stakeholders can act on.
- Make the report **exportable as a PDF** for use in proposals, QBRs, and client deliverables.
- Establish a **repeatable scoring model** so re-running WII on the same site later shows real trend, not noise.

## 4. Non-Goals (MVP)

- No crawling of authenticated/gated pages, staging environments, or non-public URLs.
- No crawling beyond 25 pages per run (no full-site exhaustive audits in MVP).
- No competitor comparison / multi-site benchmarking view (single-site report only).
- No automated remediation (WII diagnoses; it does not fix code, content, or WordPress config).
- No support for non-WordPress-specific CMS maintainability checks beyond generic technical checks (WordPress maintainability module assumes/detects WP; non-WP sites simply skip that category, not attempt CMS-specific parity).
- No scheduled/recurring automatic re-crawls in MVP (on-demand runs only).
- No mobile app or client-facing self-serve portal — MVP is an internal tool for Formist staff.
- No multi-language/i18n scoring nuance (evidence and scoring assume primary-language content in MVP).
- No JS-heavy SPA full render-diffing beyond what a headless browser render provides (best-effort rendering, not pixel-perfect QA).
- No historical trend UI in MVP (each report stands alone; trend comparison is a fast-follow).

## 5. User Stories

**As a Formist account strategist**, I want to paste a prospect's URL and get a scored report before a pitch call, so I can walk in with concrete, evidence-backed talking points instead of generic best-practice slides.

**As a Formist account strategist**, I want the report to explain findings in plain, client-ready language, so I can share it directly with a non-technical client without translating jargon myself.

**As a Formist project lead**, I want a prioritized roadmap from the report, so I can scope a statement of work around the highest-impact fixes first.

**As a Formist project lead**, I want to export the report as a PDF, so I can attach it to a proposal or send it in an email without needing the client to log into any tool.

**As a Formist developer**, I want each score to show the specific evidence (URLs, values, screenshots/snippets) behind it, so I can verify the finding is real before committing to it in a client conversation.

**As a Formist WordPress specialist**, I want a maintainability score for WP sites specifically, so I can flag plugin/theme/version risk that generic SEO tools don't surface.

**As a Formist analytics lead**, I want the report to check whether analytics/tagging is present and firing correctly, so I can identify measurement gaps before we take over a client's marketing.

**As an internal admin**, I want to see the status of a running crawl (queued/crawling/scoring/done/failed), so I know when a report is ready or if something needs attention.

**As an internal admin**, I want failed or partial crawls to still produce a report where possible (with gaps clearly marked), so a single blocked page doesn't waste the whole run.

## 6. MVP Requirements

### 6.1 Input & Crawl
- Accept one public website URL as input (normalize scheme, trailing slash, www variants).
- Validate the URL is reachable and publicly accessible (reject localhost/private IPs, non-HTTP(S) schemes).
- Crawl up to **25 pages**, starting from the homepage, following internal links (breadth-first), respecting `robots.txt` and a reasonable per-request rate limit.
- Prioritize crawl order to include: homepage, top-nav pages, sitemap.xml entries (if present), and pages linked from homepage — so the 25-page cap captures representative, high-value pages rather than an arbitrary subset.
- Render pages with a headless browser (to capture JS-rendered content) with a raw HTTP fallback if rendering fails or times out.
- Record per-page crawl status (success, timeout, blocked by robots, 4xx/5xx, redirect) so gaps are traceable in the evidence layer.

### 6.2 Evidence Collection (by category)
For each of the 10 categories below, collect concrete, storable evidence — not just a score — for every scored dimension:

1. **Technical SEO** — robots.txt validity, XML sitemap presence/validity, canonical tags, indexability (noindex/meta robots), HTTP status health, redirect chains, crawlability, structured data (schema.org) presence/validity, HTTPS/mixed-content issues, duplicate content signals.
2. **On-page SEO** — title tags (presence/length/uniqueness), meta descriptions, heading hierarchy (H1/H2 usage), image alt text coverage, internal linking density, URL structure, content length/thinness signals.
3. **AI discoverability** — presence/correctness of `llms.txt` (if applicable), structured data usable by AI crawlers, semantic HTML clarity, content extractability (is main content parseable without heavy JS), presence of clear entity/brand signals (org schema, author/byline data), crawlability by known AI user-agents (e.g., GPTBot, ClaudeBot) per robots.txt.
4. **Performance** — Core Web Vitals (LCP, CLS, INP where measurable), page weight, request count, render-blocking resources, image optimization, caching headers.
5. **Accessibility** — automated WCAG 2.1 AA checks (contrast, alt text, form labels, ARIA misuse, heading structure, keyboard-navigable landmarks) via an automated audit engine (e.g., axe-core).
6. **Security** — HTTPS enforcement/HSTS, TLS certificate validity, mixed content, exposed sensitive files (e.g., `.env`, `wp-config.php` backups), security headers (CSP, X-Frame-Options, etc.), outdated known-vulnerable libraries where detectable.
7. **Analytics** — presence and correct firing of an analytics tag (GA4/GTM or equivalent), consent/cookie banner presence, duplicate tracking tag detection, basic event/conversion tag presence.
8. **WordPress maintainability** *(WP sites only, auto-detected)* — WP core version currency, detectable plugin/theme inventory and update staleness, known-vulnerable plugin signals, admin path exposure, backup/security plugin presence signals.
9. **Brand experience** — visual consistency signals (favicon, consistent metadata/branding across pages), mobile responsiveness, broken-image/broken-asset detection, 404 handling quality.
10. **Conversion** — presence and clarity of calls-to-action, contact/lead-capture form presence and basic functional check (renders, has required fields), phone/email/contact discoverability, checkout/lead-flow friction signals where detectable without submitting real data.

Each evidence item must record: category, check name, observed value, the specific page(s)/URL(s) it was observed on, timestamp, and a severity/impact tag.

### 6.3 Scoring
- Compute a **category score (0–100)** per category from its evidence items (see Section 8).
- Compute an **overall WII score (0–100)** as a weighted roll-up of category scores.
- Map overall score to a **letter grade** (A–F, see Section 8.3).
- Compute a derived **Business Risk** rating (Low/Medium/High/Critical) from security, technical SEO, accessibility-legal-exposure, and WordPress maintainability signals.
- Compute a derived **AI Readiness** rating (0–100 or Low/Medium/High) primarily from the AI discoverability category plus supporting technical SEO/structured-data signals.

### 6.4 Report Generation
- Generate a report containing all sections in Section 9, viewable in-app.
- Generate a **client-ready PDF export** of the same report, suitable to send externally without edits.
- Persist the report (and its underlying evidence) so it can be reopened/re-exported later without re-crawling.

### 6.5 Operational
- Show run status (queued → crawling → scoring → complete → failed) to the requesting user.
- On partial failure (e.g., some pages blocked/unreachable), still produce a report, and mark affected scores/evidence as "limited data" rather than silently omitting them.
- Log enough per-run metadata (URL, timestamp, pages crawled, duration, requester) for internal QA and troubleshooting.

## 7. Data Model

```
Website
  id
  root_url (normalized)
  detected_cms            # e.g., "wordpress" | "other" | "unknown"
  created_at

Run
  id
  website_id (FK -> Website)
  requested_by            # internal user identifier
  status                  # queued | crawling | scoring | complete | failed
  started_at
  completed_at
  pages_requested          # cap, e.g. 25
  pages_crawled_count
  failure_reason           # nullable

Page
  id
  run_id (FK -> Run)
  url
  http_status
  crawl_status             # success | timeout | blocked_by_robots | error | redirect
  final_url                # after redirects
  rendered                 # bool, headless-rendered vs raw-HTTP fallback
  fetched_at

EvidenceItem
  id
  run_id (FK -> Run)
  page_id (FK -> Page, nullable for site-wide checks e.g. robots.txt/sitemap)
  category                 # one of the 10 categories
  check_name               # e.g., "title_tag_length", "hsts_header_present"
  observed_value            # raw finding (string/JSON)
  severity                  # info | minor | moderate | major | critical
  passed                    # bool
  detail                    # human-readable explanation
  recommendation            # nullable, linked remediation text

CategoryScore
  id
  run_id (FK -> Run)
  category
  score                     # 0-100
  evidence_ids              # supporting EvidenceItem references
  summary                   # short client-readable summary

Report
  id
  run_id (FK -> Run, 1:1)
  overall_score             # 0-100
  grade                      # A | B | C | D | F
  business_risk              # Low | Medium | High | Critical
  ai_readiness                # score or Low/Medium/High
  category_scores             # ordered list -> CategoryScore
  roadmap                     # ordered list of RoadmapItem
  recommendations              # list of client-ready recommendation strings
  pdf_url                       # generated export location
  generated_at

RoadmapItem
  id
  report_id (FK -> Report)
  priority_rank              # 1 = highest priority
  title
  category
  impact                      # High | Medium | Low (business impact)
  effort                       # High | Medium | Low (estimated effort)
  linked_evidence_ids
```

## 8. Scoring Model

### 8.1 Category weighting (overall WII score)

Weighted roll-up of the 10 categories into the overall 0–100 score:

| Category | Weight |
|---|---|
| Technical SEO | 15% |
| On-page SEO | 12% |
| AI discoverability | 12% |
| Performance | 12% |
| Accessibility | 10% |
| Security | 12% |
| Analytics | 8% |
| WordPress maintainability* | 8% |
| Brand experience | 6% |
| Conversion | 5% |

*If a site is not detected as WordPress, the WordPress maintainability category is excluded and its weight is redistributed proportionally across the remaining 9 categories, so overall score remains comparable across CMS types. This redistribution rule must be visible in the report methodology note.

### 8.2 Category score calculation
Each category score is the weighted average of its underlying evidence checks, where each check contributes:
- **Pass/fail checks** (e.g., HTTPS enforced): full points if pass, zero (or partial, if a defined partial-credit tier exists, e.g., "HTTPS present but no HSTS") if fail.
- **Graduated checks** (e.g., % of images with alt text, Core Web Vitals against defined thresholds): scored on a defined scale (e.g., 0–100 linear or thresholded bands sourced from published standards like Core Web Vitals "Good/Needs Improvement/Poor").
- Severity-weighted deduction: `critical` findings deduct more than `minor` findings within a category, so one critical security exposure can't be diluted by many trivial passes.
- Checks with insufficient data (page unreachable, feature not applicable) are excluded from that category's denominator rather than scored as failing, and the report flags reduced confidence when a category has significant missing data (e.g., >30% of applicable checks unresolved).

### 8.3 Grade mapping

| Score range | Grade |
|---|---|
| 90–100 | A |
| 80–89 | B |
| 70–79 | C |
| 60–69 | D |
| Below 60 | F |

### 8.4 Business Risk
Derived (not simply averaged) from the presence of high-severity findings in Security, Technical SEO (indexability/crawl blockers), Accessibility (legal-exposure-relevant failures, e.g., ADA/WCAG blockers), and WordPress maintainability (known-vulnerable/outdated core or plugins):
- **Critical**: any single critical-severity finding in Security or WordPress maintainability (e.g., exposed credentials file, known-vulnerable plugin with public exploit).
- **High**: multiple major-severity findings across risk-relevant categories, or overall Security/Accessibility category score below 50.
- **Medium**: isolated major findings or category scores in the 50–75 range.
- **Low**: no major/critical findings; risk-relevant categories score above 75.

### 8.5 AI Readiness
Primarily driven by the AI discoverability category score, adjusted by supporting signals from Technical SEO (structured data validity, crawlability) and On-page SEO (content extractability). Reported as both a 0–100 score and a Low/Medium/High label using the same band thresholds as Section 8.3, for consistency with the overall grade.

## 9. Report Sections

The generated report (in-app and PDF) must include, in this order:

1. **Cover / Summary** — site URL, crawl date, pages crawled, overall WII score, grade.
2. **Executive Summary** — 3–5 sentence plain-language summary of overall health, written for a non-technical client stakeholder.
3. **Overall WII Score & Grade** — the headline number, grade, and a short methodology note (including any weight-redistribution note per 8.1).
4. **Business Risk** — rating with the specific driving findings called out.
5. **AI Readiness** — rating with the specific driving findings called out.
6. **Category Scores** — all 10 (or 9, if non-WP) categories with individual scores, shown comparatively (e.g., bar/table).
7. **Evidence by Category** — for each category, the supporting evidence items (specific pages, values, severity), organized so every score is traceable to a concrete finding.
8. **Priority Roadmap** — ranked list of recommended actions (impact vs. effort), tied back to the evidence that motivated them.
9. **Client-Ready Recommendations** — plain-language, non-technical rewrite of the roadmap suitable for direct client consumption (no jargon, no internal tool names).
10. **Methodology & Limitations** — crawl scope (≤25 pages), what was/wasn't checked, confidence notes for categories with limited data.
11. **Appendix: Full Page List** — the crawled pages and their individual crawl status, for internal QA/traceability.

## 10. Acceptance Criteria

- Given a valid public URL, submitting a WII run crawls up to 25 pages and reaches a `complete` status without manual intervention, in the common case (no crawl blockers).
- The report always includes: overall score (0–100), grade, business risk, AI readiness, all applicable category scores, evidence per score, a priority roadmap, client-ready recommendations, and a working PDF export — for any successfully completed run.
- Every category score displayed in the report links to at least one concrete evidence item (specific page/value), with no score presented without traceable evidence.
- WordPress sites are auto-detected and receive a WordPress maintainability score; non-WordPress sites omit that category and the weight redistribution is reflected in the score without the report breaking or showing a zero/blank category.
- If the crawl is blocked entirely (e.g., robots.txt disallows all, site unreachable), the run fails gracefully with a clear, actionable error rather than producing a misleading partial score.
- If some pages fail mid-crawl but at least a minimum viable set succeeds (e.g., homepage + some internal pages), the report still generates, with affected categories/evidence marked as based on limited data.
- The PDF export renders all report sections listed in Section 9, is generated without requiring the recipient to have tool access, and opens correctly in standard PDF viewers.
- Re-running WII against the same URL at a later date produces a new, independently stored report (does not overwrite the prior run), enabling future before/after comparison.
- Scores are deterministic for the same crawl data: given the same evidence set, the scoring model produces the same category and overall scores every time (no randomness in scoring).
- The system rejects non-public URLs (localhost, private IP ranges, non-HTTP(S) schemes) at submission time with a clear validation error.
- A crawl respects `robots.txt` disallow rules; pages disallowed for crawling are not fetched and are recorded as `blocked_by_robots` rather than silently skipped.

## 11. Risks & Assumptions

**Assumptions**
- Target sites are public, unauthenticated, and reachable over standard HTTP(S) without special network access.
- 25 pages is a representative enough sample for MVP scoring purposes on typical small-to-mid-size business sites (may be a smaller proportion of coverage on very large sites — this is an accepted MVP tradeoff, not a defect).
- Headless rendering is sufficient to approximate what a typical user/browser sees; pixel-perfect rendering parity is not required.
- Internal Formist staff are the only users in MVP; no external/client self-serve access is needed yet.
- WordPress detection can be done reliably via standard fingerprinting (meta generator tags, common paths like `/wp-content/`, `/wp-json/`) without needing site credentials.

**Risks**
- **Crawl blocking**: some sites will aggressively block automated crawlers (WAF, bot protection, aggressive robots.txt), producing incomplete or zero-data runs; mitigation is graceful partial-report generation and clear "limited data" flagging, not guaranteed full coverage.
- **JS-heavy sites**: some SPAs may not fully render headlessly within timeout budgets, understating content/AI-discoverability scores; mitigation is the raw-HTTP fallback plus explicit confidence flagging, not perfect parity.
- **False precision**: presenting a single 0–100 number risks being read as more authoritative than the underlying automated checks warrant; mitigation is the mandatory Methodology & Limitations section and visible evidence linkage on every score.
- **Legal/accessibility scope**: automated accessibility checks (e.g., axe-core-style) catch a subset of WCAG issues and are not a substitute for a full manual/legal accessibility audit; the report must not be presented as legal compliance certification.
- **WordPress fingerprinting accuracy**: plugin/theme/version detection from public-facing signals can be incomplete or spoofed by security hardening, understating or overstating maintainability risk.
- **Scoring model drift**: as checks are added/reweighted post-MVP, historical scores may not be comparable to future scores unless the methodology version is recorded per report; mitigation is stamping each report with a scoring-model version identifier.
- **Rate limiting / courtesy**: aggressive crawling of a client or prospect's site could be mistaken for hostile traffic or trip their own rate limits/WAF; mitigation is conservative concurrency and request pacing, respecting `robots.txt` and standard crawl-delay conventions.
- **Sensitive-file checks**: security checks that probe for exposed files (e.g., `.env`, config backups) must be limited to passive/non-destructive requests only, to avoid the appearance of unauthorized security testing against a site Formist doesn't own or have explicit permission to assess.
