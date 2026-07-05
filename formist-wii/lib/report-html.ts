import { CATEGORY_LABELS } from "@/lib/scoring";
import type { EvidenceCategory } from "@/generated/prisma/enums";

type ReportHtmlData = {
  rootUrl: string;
  overallScore: number;
  grade: string;
  businessRisk: string;
  aiReadiness: number;
  methodologyNote: string;
  categoryScores: { category: EvidenceCategory; score: number; maxScore: number; rationale: string }[];
  roadmap: {
    priorityRank: number;
    title: string;
    category: EvidenceCategory;
    impact: string;
    effort: string;
    recommendation: string;
  }[];
  recommendations: string[];
  generatedAt: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders a self-contained HTML snapshot of the report, stored on Report.html for export/archival. */
export function buildReportHtml(data: ReportHtmlData): string {
  const categoryRows = [...data.categoryScores]
    .sort((a, b) => b.score / b.maxScore - a.score / a.maxScore)
    .map(
      (cs) => `
        <tr>
          <td>${escapeHtml(CATEGORY_LABELS[cs.category])}</td>
          <td>${cs.score}/${cs.maxScore}</td>
          <td>${escapeHtml(cs.rationale)}</td>
        </tr>`
    )
    .join("");

  const roadmapRows = data.roadmap
    .map(
      (item) => `
        <tr>
          <td>${item.priorityRank}</td>
          <td>${escapeHtml(item.title)}</td>
          <td>${escapeHtml(CATEGORY_LABELS[item.category])}</td>
          <td>${escapeHtml(item.impact)}</td>
          <td>${escapeHtml(item.effort)}</td>
        </tr>`
    )
    .join("");

  const recommendationItems = data.recommendations
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Website Intelligence Index Report — ${escapeHtml(data.rootUrl)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; max-width: 860px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 32px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  .muted { color: #6b7280; font-size: 13px; }
  .score { font-size: 40px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; }
  ul { padding-left: 20px; }
</style>
</head>
<body>
  <p class="muted">Website Intelligence Index Report</p>
  <h1>${escapeHtml(data.rootUrl)}</h1>
  <p class="muted">Generated ${escapeHtml(data.generatedAt)}</p>

  <p class="score">${data.overallScore}/100 &middot; Grade ${escapeHtml(data.grade)}</p>
  <p><strong>Business risk:</strong> ${escapeHtml(data.businessRisk)} &middot; <strong>AI readiness:</strong> ${data.aiReadiness}/100</p>

  <h2>Category scores</h2>
  <table>
    <thead><tr><th>Category</th><th>Score</th><th>Rationale</th></tr></thead>
    <tbody>${categoryRows}</tbody>
  </table>

  <h2>Priority roadmap</h2>
  <table>
    <thead><tr><th>#</th><th>Action</th><th>Category</th><th>Impact</th><th>Effort</th></tr></thead>
    <tbody>${roadmapRows}</tbody>
  </table>

  <h2>Client-ready recommendations</h2>
  <ul>${recommendationItems}</ul>

  <h2>Methodology &amp; limitations</h2>
  <p class="muted">${escapeHtml(data.methodologyNote)}</p>
</body>
</html>`;
}
