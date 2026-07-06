import Link from "next/link";

import { cn } from "@/lib/utils";

const TABS = [
  { key: "report", label: "Report", href: (id: string) => `/reports/${id}` },
  { key: "scorecard", label: "Scorecard", href: (id: string) => `/reports/${id}/scorecard` },
  { key: "evidence", label: "Evidence", href: (id: string) => `/reports/${id}/evidence` },
] as const;

export function ReportSubNav({
  reportId,
  active,
}: {
  reportId: string;
  active: (typeof TABS)[number]["key"];
}) {
  return (
    <nav className="mb-6 flex items-center gap-1 border-b print:hidden">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href(reportId)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
            tab.key === active
              ? "border-primary text-foreground"
              : "text-muted-foreground border-transparent hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
