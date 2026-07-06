import fs from "node:fs";
import path from "node:path";
import type { ReportData, ReportEvidenceItem } from "@/lib/report-service";
import type { CategoryStatus, Severity } from "@/generated/prisma/enums";

/**
 * Renders a ReportData object (see lib/report-service.ts) to a single, self-contained HTML
 * document — all 11 report sections, in order, inline CSS, screenshots embedded as base64 data
 * URIs so the file has no external dependencies. Consumed both for the archival Report.html
 * column and as the source Playwright renders to PDF (generateReportPdf in report-service.ts).
 */

const STATUS_COLOR: Record<CategoryStatus, string> = {
  good: "#059669",
  needs_attention: "#d97706",
  poor: "#dc2626",
  critical: "#991b1b",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  info: "#6b7280",
  minor: "#6b7280",
  moderate: "#d97706",
  major: "#dc2626",
  critical: "#991b1b",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function embedScreenshot(publicPath: string): string | null {
  try {
    const filePath = path.join(process.cwd(), "public", publicPath);
    const buffer = fs.readFileSync(filePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function badge(text: string, color: string): string {
  return `<span class="badge" style="background:${color}1a;color:${color};border:1px solid ${color}40;">${escapeHtml(text)}</span>`;
}

function scoreBar(score: number, maxScore: number, color: string): string {
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>`;
}

function evidenceList(items: ReportEvidenceItem[]): string {
  if (items.length === 0) return `<p class="muted">No evidence recorded.</p>`;
  return `<ul class="evidence-list">${items
    .map(
      (e) => `
        <li>
          ${badge(e.severity, SEVERITY_COLOR[e.severity])}
          <span>${escapeHtml(e.finding)}</span>
          ${e.url ? `<span class="muted small block">${escapeHtml(e.url)}</span>` : ""}
        </li>`
    )
    .join("")}</ul>`;
}

function renderCover(data: ReportData): string {
  const { cover } = data;
  return `
    <section class="cover">
      <p class="eyebrow">Website Intelligence Index Report</p>
      <h1>${escapeHtml(cover.clientName ?? cover.rootUrl)}</h1>
      <p class="muted">${escapeHtml(cover.rootUrl)}</p>
      <p class="muted small">
        Generated ${escapeHtml(new Date(cover.generatedAt).toLocaleString())} ·
        ${cover.pagesCrawled} of ${cover.pagesRequested} pages crawled
        ${cover.detectedCms === "wordpress" ? " · WordPress detected" : ""}
      </p>
      <div class="cover-score">
        <span class="score-number">${cover.overallScore}</span>
        <span class="score-suffix">/100 &middot; Grade ${escapeHtml(cover.grade)}</span>
      </div>
    </section>`;
}

function renderExecutiveSummary(data: ReportData): string {
  const risks = data.topRisks.length
    ? `<div class="scorecard-cell"><p class="label">Top risks</p><ul class="plain-list">${data.topRisks.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>`
    : "";
  const opportunities = data.topOpportunities.length
    ? `<div class="scorecard-cell"><p class="label">Top opportunities</p><ul class="plain-list">${data.topOpportunities.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>`
    : "";
  return `
    <section>
      <h2>Executive Summary</h2>
      <p>${escapeHtml(data.executiveSummary)}</p>
      ${risks || opportunities ? `<div class="scorecard-grid" style="grid-template-columns: repeat(2, 1fr);">${risks}${opportunities}</div>` : ""}
    </section>`;
}

function renderExecutiveScorecard(data: ReportData): string {
  const s = data.executiveScorecard;
  const drivers = s.businessRiskDrivers.length
    ? `<ul class="plain-list">${s.businessRiskDrivers.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
    : `<p class="muted small">No major or critical risk-relevant findings.</p>`;

  return `
    <section>
      <h2>Executive Scorecard</h2>
      <div class="scorecard-grid">
        <div class="scorecard-cell">
          <p class="label">Business risk</p>
          ${badge(s.businessRisk, STATUS_COLOR.critical)}
          ${drivers}
        </div>
        <div class="scorecard-cell">
          <p class="label">AI readiness</p>
          <p class="scorecard-value">${s.aiReadiness.score}/100 &middot; ${escapeHtml(s.aiReadiness.label)}</p>
        </div>
        <div class="scorecard-cell">
          <p class="label">Priority</p>
          ${badge(s.priority, STATUS_COLOR.critical)}
        </div>
      </div>
      <p class="muted small">${escapeHtml(s.methodologyNote)}</p>
    </section>`;
}

function renderOverallIndex(data: ReportData): string {
  const rows = data.overallIndex.categoryBreakdown
    .map(
      (c) => `
        <tr>
          <td>${escapeHtml(c.label)}</td>
          <td class="nowrap">${c.score}/${c.maxScore}</td>
          <td>${scoreBar(c.score, c.maxScore, STATUS_COLOR[c.status])}</td>
        </tr>`
    )
    .join("");
  return `
    <section>
      <h2>Overall Website Intelligence Index</h2>
      <p class="score-large">${data.overallIndex.overallScore}<span class="muted">/100 &middot; Grade ${escapeHtml(data.overallIndex.grade)}</span></p>
      <table>
        <thead><tr><th>Category</th><th>Score</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderKeyFindings(data: ReportData): string {
  if (data.keyFindings.length === 0) {
    return `<section><h2>Key Findings</h2><p class="muted">No significant findings — the site is in solid shape across all categories.</p></section>`;
  }
  const items = data.keyFindings
    .map(
      (f) => `
        <li>
          ${badge(f.severity, SEVERITY_COLOR[f.severity])}
          <span class="muted small">${escapeHtml(f.categoryLabel)}</span>
          <span class="block">${escapeHtml(f.finding)}</span>
        </li>`
    )
    .join("");
  return `
    <section>
      <h2>Key Findings</h2>
      <ul class="evidence-list">${items}</ul>
    </section>`;
}

function renderCategoryDeepDives(data: ReportData): string {
  const cards = data.categoryDeepDives
    .map(
      (cs) => `
        <div class="card">
          <div class="card-header">
            <span class="card-title">${escapeHtml(cs.label)}</span>
            <span class="muted">${cs.score}/${cs.maxScore}</span>
          </div>
          ${scoreBar(cs.score, cs.maxScore, STATUS_COLOR[cs.status])}
          <p class="muted small">${escapeHtml(cs.rationale)}</p>
          ${evidenceList(cs.evidence)}
        </div>`
    )
    .join("");
  return `
    <section>
      <h2>Category Deep Dives</h2>
      ${cards}
    </section>`;
}

function renderAiDiscoverability(data: ReportData): string {
  const a = data.aiDiscoverabilityAssessment;
  const strategist = a.strategistPerspective
    ? `
        <div class="strategist-box">
          <p class="label">Strategist perspective</p>
          <p>${escapeHtml(a.strategistPerspective.rationale)}</p>
        </div>`
    : "";
  return `
    <section>
      <h2>AI Discoverability Assessment</h2>
      <div class="card">
        <div class="card-header">
          <span class="card-title">AI Discoverability</span>
          <span class="muted">${a.score}/${a.maxScore}</span>
        </div>
        ${scoreBar(a.score, a.maxScore, STATUS_COLOR[a.status])}
        <p class="muted small">${escapeHtml(a.rationale)}</p>
        ${strategist}
        ${evidenceList(a.evidence)}
      </div>
    </section>`;
}

function renderWordpressMaintainability(data: ReportData): string {
  const w = data.wordpressMaintainabilityAssessment;
  if (!w.applicable) {
    return `
      <section>
        <h2>WordPress Maintainability Assessment</h2>
        <p class="muted">${escapeHtml(w.note)}</p>
      </section>`;
  }
  return `
    <section>
      <h2>WordPress Maintainability Assessment</h2>
      <div class="card">
        <div class="card-header">
          <span class="card-title">WordPress Maintainability</span>
          <span class="muted">${w.score}/${w.maxScore}</span>
        </div>
        ${scoreBar(w.score, w.maxScore, STATUS_COLOR[w.status])}
        <p class="muted small">${escapeHtml(w.rationale)}</p>
        ${evidenceList(w.evidence)}
      </div>
    </section>`;
}

function renderPriorityRoadmap(data: ReportData): string {
  const rows = data.priorityRoadmap
    .map(
      (r) => `
        <tr>
          <td>${r.priorityRank}</td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.categoryLabel)}</td>
          <td>${escapeHtml(r.impact)}</td>
          <td>${escapeHtml(r.effort)}</td>
        </tr>`
    )
    .join("");
  const body =
    data.priorityRoadmap.length > 0
      ? `<table><thead><tr><th>#</th><th>Action</th><th>Category</th><th>Impact</th><th>Effort</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No high-priority issues found.</p>`;
  return `
    <section>
      <h2>Priority Roadmap</h2>
      <p class="muted small">${escapeHtml(data.priorityRoadmapNarrative)}</p>
      ${body}
    </section>`;
}

function renderRecommendedNextSteps(data: ReportData): string {
  const items =
    data.recommendedNextSteps.length > 0
      ? `<ul class="plain-list">${data.recommendedNextSteps.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
      : `<p class="muted">No outstanding recommendations.</p>`;
  return `
    <section>
      <h2>Recommended Next Steps</h2>
      ${items}
    </section>`;
}

function renderScreenshots(data: ReportData): string {
  if (data.screenshots.length === 0) return "";
  const images = data.screenshots
    .map((s) => {
      const embedded = embedScreenshot(s.path);
      if (!embedded) return "";
      return `
        <figure>
          <img src="${embedded}" alt="Screenshot of ${escapeHtml(s.pageUrl)}" />
          <figcaption class="muted small">${escapeHtml(s.pageUrl)}</figcaption>
        </figure>`;
    })
    .join("");
  return `
    <section>
      <h2>Site Snapshots</h2>
      <div class="screenshot-grid">${images}</div>
    </section>`;
}

function renderAppendixEvidence(data: ReportData): string {
  const groups = data.appendixEvidence
    .map(
      (g) => `
        <div class="card">
          <p class="card-title">${escapeHtml(g.categoryLabel)}</p>
          ${evidenceList(g.items)}
        </div>`
    )
    .join("");
  return `
    <section>
      <h2>Appendix: Evidence</h2>
      <p class="muted small">Every finding behind every score, organized by category, for full traceability.</p>
      ${groups}
    </section>`;
}

export function buildReportHtml(data: ReportData): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Website Intelligence Index Report — ${escapeHtml(data.cover.rootUrl)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; max-width: 880px; margin: 40px auto; padding: 0 20px; line-height: 1.5; }
  h1 { font-size: 26px; margin: 4px 0 0; }
  h2 { font-size: 17px; margin: 0 0 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
  section { margin-top: 36px; }
  .eyebrow { color: #6b7280; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; margin: 0; }
  .muted { color: #6b7280; }
  .small { font-size: 12px; }
  .block { display: block; margin-top: 2px; }
  .nowrap { white-space: nowrap; }
  .label { color: #6b7280; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; margin: 0 0 6px; }
  .cover-score { margin-top: 18px; }
  .score-number { font-size: 48px; font-weight: 700; }
  .score-suffix { color: #6b7280; font-size: 15px; margin-left: 6px; }
  .score-large { font-size: 32px; font-weight: 700; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .bar { height: 6px; border-radius: 3px; background: #e5e7eb; overflow: hidden; margin: 4px 0; min-width: 80px; }
  .bar-fill { height: 100%; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: capitalize; }
  .scorecard-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 12px; }
  .scorecard-cell { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; }
  .scorecard-value { font-size: 18px; font-weight: 700; margin: 4px 0 0; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; margin-top: 14px; page-break-inside: avoid; }
  .card-header { display: flex; justify-content: space-between; align-items: center; }
  .card-title { font-weight: 600; }
  .strategist-box { background: #f9fafb; border-radius: 6px; padding: 10px 12px; margin: 10px 0; font-size: 13px; }
  .evidence-list { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .evidence-list li { border-left: 2px solid #e5e7eb; padding-left: 10px; }
  .plain-list { padding-left: 20px; }
  .screenshot-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .screenshot-grid img { width: 100%; border: 1px solid #e5e7eb; border-radius: 6px; }
  figure { margin: 0; }
</style>
</head>
<body>
  ${renderCover(data)}
  ${renderExecutiveSummary(data)}
  ${renderExecutiveScorecard(data)}
  ${renderOverallIndex(data)}
  ${renderKeyFindings(data)}
  ${renderCategoryDeepDives(data)}
  ${renderAiDiscoverability(data)}
  ${renderWordpressMaintainability(data)}
  ${renderPriorityRoadmap(data)}
  ${renderRecommendedNextSteps(data)}
  ${renderScreenshots(data)}
  ${renderAppendixEvidence(data)}
</body>
</html>`;
}
