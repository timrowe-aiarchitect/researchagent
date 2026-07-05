import Link from "next/link";
import { Plus } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RunStatusBadge, GradeBadge } from "@/components/status-badges";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const runs = await prisma.run.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { website: true, report: { select: { id: true, overallScore: true, grade: true } } },
  });

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Recent Website Intelligence Index scans across client and prospect sites.
          </p>
        </div>
        <Button asChild>
          <Link href="/scans/new">
            <Plus />
            New scan
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent scans</CardTitle>
          <CardDescription>
            {runs.length === 0
              ? "No scans yet — start your first one."
              : `Showing the ${runs.length} most recent scan(s).`}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          {runs.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-12 text-sm">
              <p>Run a scan against a public website to generate its first WII report.</p>
              <Button asChild>
                <Link href="/scans/new">
                  <Plus />
                  New scan
                </Link>
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Website</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead className="text-right">Report</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="max-w-xs truncate font-medium">
                      <Link href={`/scans/${run.id}`} className="hover:underline">
                        {run.website.rootUrl}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>
                      {run.report ? (
                        <div className="flex items-center gap-2">
                          <GradeBadge grade={run.report.grade} />
                          <span className="text-muted-foreground text-sm">
                            {run.report.overallScore}/100
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {run.createdAt.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {run.report ? (
                        <Link
                          href={`/reports/${run.report.id}`}
                          className="text-primary text-sm font-medium hover:underline"
                        >
                          View report
                        </Link>
                      ) : (
                        <Link
                          href={`/scans/${run.id}`}
                          className="text-muted-foreground text-sm hover:underline"
                        >
                          View status
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
