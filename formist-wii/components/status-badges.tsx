import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CategoryStatus, Severity } from "@/generated/prisma/enums";

export function RunStatusBadge({ status }: { status: string }) {
  const variant =
    status === "complete"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "crawling" || status === "scoring"
          ? "warning"
          : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

export function GradeBadge({ grade, className }: { grade: string; className?: string }) {
  const variant =
    grade === "A" || grade === "B" ? "success" : grade === "C" ? "warning" : "destructive";
  return (
    <Badge variant={variant} className={cn("h-7 px-2.5 text-sm font-bold", className)}>
      {grade}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: string }) {
  const variant =
    risk === "low" ? "success" : risk === "medium" ? "warning" : "destructive";
  return (
    <Badge variant={variant} className="capitalize">
      {risk}
    </Badge>
  );
}

const CATEGORY_STATUS_LABEL: Record<CategoryStatus, string> = {
  good: "Strong",
  needs_attention: "Fair",
  poor: "Needs Improvement",
  critical: "Critical",
};

const CATEGORY_STATUS_VARIANT: Record<CategoryStatus, "success" | "warning" | "destructive"> = {
  good: "success",
  needs_attention: "warning",
  poor: "destructive",
  critical: "destructive",
};

export function CategoryStatusBadge({
  status,
  className,
}: {
  status: CategoryStatus;
  className?: string;
}) {
  return (
    <Badge variant={CATEGORY_STATUS_VARIANT[status]} className={className}>
      {CATEGORY_STATUS_LABEL[status]}
    </Badge>
  );
}

const SEVERITY_VARIANT: Record<Severity, "success" | "warning" | "destructive" | "secondary"> = {
  info: "secondary",
  minor: "secondary",
  moderate: "warning",
  major: "destructive",
  critical: "destructive",
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <Badge variant={SEVERITY_VARIANT[severity]} className={cn("capitalize", className)}>
      {severity}
    </Badge>
  );
}
