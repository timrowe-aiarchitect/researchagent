"use client";

import { useMemo, useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SeverityBadge } from "@/components/status-badges";
import type { EvidenceCategory, Severity } from "@/generated/prisma/enums";

export type EvidenceRow = {
  category: EvidenceCategory;
  categoryLabel: string;
  source: string;
  severity: Severity;
  finding: string;
  url: string | null;
};

const SEVERITY_ORDER: Severity[] = ["critical", "major", "moderate", "minor", "info"];

const selectClassName =
  "border-input bg-transparent h-9 rounded-md border px-3 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EvidenceTable({
  rows,
  categories,
}: {
  rows: EvidenceRow[];
  categories: { value: EvidenceCategory; label: string }[];
}) {
  const [category, setCategory] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");

  const filtered = useMemo(() => {
    return rows
      .filter((r) => category === "all" || r.category === category)
      .filter((r) => severity === "all" || r.severity === severity)
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  }, [rows, category, severity]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Filter by category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={selectClassName}
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className={selectClassName}
        >
          <option value="all">All severities</option>
          {SEVERITY_ORDER.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground text-sm">
          Showing {filtered.length} of {rows.length} evidence items
        </span>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Check</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Finding</TableHead>
              <TableHead>Page</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="text-sm whitespace-nowrap">{r.categoryLabel}</TableCell>
                <TableCell className="text-sm whitespace-nowrap capitalize">
                  {r.source.replace(/_/g, " ")}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={r.severity} />
                </TableCell>
                <TableCell className="max-w-md text-sm whitespace-normal">{r.finding}</TableCell>
                <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                  {r.url ?? "—"}
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No evidence matches these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
