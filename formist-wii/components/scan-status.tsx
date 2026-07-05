"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { RunStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";

type ScanState = {
  status: string;
  pagesRequested: number;
  pagesCrawled: number;
  failureReason: string | null;
  reportId: string | null;
};

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(["complete", "failed"]);

export function ScanStatus({
  scanId,
  initial,
}: {
  scanId: string;
  initial: ScanState;
}) {
  const router = useRouter();
  const [state, setState] = useState<ScanState>(initial);
  const redirectedRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(state.status)) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/scans/${scanId}`);
      if (!res.ok) return;
      const data = await res.json();
      setState({
        status: data.status,
        pagesRequested: data.pagesRequested,
        pagesCrawled: data.pagesCrawled,
        failureReason: data.failureReason,
        reportId: data.reportId,
      });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [scanId, state.status]);

  useEffect(() => {
    if (state.status === "complete" && state.reportId && !redirectedRef.current) {
      redirectedRef.current = true;
      router.push(`/reports/${state.reportId}`);
    }
  }, [state.status, state.reportId, router]);

  const progressPct = Math.min(
    100,
    Math.round((state.pagesCrawled / Math.max(1, state.pagesRequested)) * 100)
  );

  return (
    <Card className="mt-6">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Crawl progress</CardTitle>
        <RunStatusBadge status={state.status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-6">
        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground flex items-center justify-between text-sm">
            <span>Pages crawled</span>
            <span>
              {state.pagesCrawled} / {state.pagesRequested}
            </span>
          </div>
          <Progress value={progressPct} />
        </div>

        {state.status === "failed" && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <p>{state.failureReason ?? "This scan failed."}</p>
          </div>
        )}

        {state.status === "complete" && state.reportId && (
          <div className="flex items-center justify-between gap-2 rounded-md border bg-success/10 p-3 text-sm">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-success" />
              Scan complete — report is ready.
            </span>
            <Button size="sm" asChild>
              <a href={`/reports/${state.reportId}`}>View report</a>
            </Button>
          </div>
        )}

        {!TERMINAL_STATUSES.has(state.status) && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            This page updates automatically…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
