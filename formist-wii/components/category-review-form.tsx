"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export type CategoryReviewData = {
  category: string;
  label: string;
  maxScore: number;
  score: number;
  rationale: string;
  automatedScore: number;
  automatedRationale: string;
  isOverridden: boolean;
  overrideNote: string | null;
  overriddenBy: string | null;
  overriddenAt: string | null;
};

export function CategoryReviewForm({
  reportId,
  data,
  locked,
}: {
  reportId: string;
  data: CategoryReviewData;
  locked: boolean;
}) {
  const router = useRouter();
  const [rationale, setRationale] = useState(data.rationale);
  const [score, setScore] = useState(data.score);
  const [note, setNote] = useState(data.overrideNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const scoreChanged = score !== data.automatedScore;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/reports/${reportId}/categories/${data.category}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rationale, score, note: note.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save review");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>{data.label}</span>
          {data.isOverridden && <Badge variant="secondary">Reviewed</Badge>}
        </CardTitle>
        <CardDescription>
          Automated: {data.automatedScore}/{data.maxScore} — {data.automatedRationale}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${data.category}-rationale`}>Rationale</Label>
            <Textarea
              id={`${data.category}-rationale`}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              disabled={locked}
              rows={3}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${data.category}-score`}>Score (of {data.maxScore})</Label>
              <Input
                id={`${data.category}-score`}
                type="number"
                step="0.1"
                min={0}
                max={data.maxScore}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
                disabled={locked}
                className="w-28"
              />
            </div>
            {data.overriddenBy && (
              <p className="text-muted-foreground text-xs">
                Last reviewed by {data.overriddenBy}
                {data.overriddenAt ? ` on ${new Date(data.overriddenAt).toLocaleString()}` : ""}
              </p>
            )}
          </div>
          {scoreChanged && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${data.category}-note`}>Note (required for a score override)</Label>
              <Textarea
                id={`${data.category}-note`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={locked}
                rows={2}
              />
            </div>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          {saved && !error && <p className="text-success text-sm">Saved.</p>}
          <Button type="submit" size="sm" disabled={locked || saving} className="self-start">
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
