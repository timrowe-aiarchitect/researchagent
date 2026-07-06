"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReportStatusBadge } from "@/components/status-badges";
import type { ReportStatus } from "@/generated/prisma/enums";

const TRANSITIONS: Record<ReportStatus, { status: ReportStatus; label: string }[]> = {
  draft: [{ status: "needs_review", label: "Submit for review" }],
  needs_review: [
    { status: "draft", label: "Send back to draft" },
    { status: "approved", label: "Approve" },
  ],
  approved: [
    { status: "needs_review", label: "Reopen for review" },
    { status: "exported", label: "Mark exported" },
  ],
  exported: [],
};

export function ReportStatusControls({ reportId, status }: { reportId: string; status: ReportStatus }) {
  const router = useRouter();
  const [current, setCurrent] = useState(status);
  const [pending, setPending] = useState<ReportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewerName, setReviewerName] = useState("");

  async function transition(next: ReportStatus) {
    setPending(next);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, reviewerName: reviewerName || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not update status");
      setCurrent(body.status);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">Report status</span>
        <ReportStatusBadge status={current} />
        <Input
          placeholder="Your name (optional)"
          value={reviewerName}
          onChange={(e) => setReviewerName(e.target.value)}
          className="h-8 max-w-48 text-sm"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {TRANSITIONS[current].map((t) => (
          <Button
            key={t.status}
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => transition(t.status)}
          >
            {pending === t.status ? "Saving…" : t.label}
          </Button>
        ))}
        {TRANSITIONS[current].length === 0 && (
          <p className="text-muted-foreground text-sm">This report is locked — no further status changes.</p>
        )}
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
