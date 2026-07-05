import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
