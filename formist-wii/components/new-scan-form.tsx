"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewScanForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [clientName, setClientName] = useState("");
  const [industry, setIndustry] = useState("");
  const [conversionGoal, setConversionGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const createRes = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          clientName: clientName || undefined,
          industry: industry || undefined,
          conversionGoal: conversionGoal || undefined,
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        const issueMessage = created.issues?.[0]?.message;
        throw new Error(issueMessage ?? created.error ?? "Could not start scan");
      }

      await fetch(`/api/scans/${created.id}/run`, { method: "POST" });

      router.push(`/scans/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="url">Website URL</Label>
        <Input
          id="url"
          type="url"
          inputMode="url"
          placeholder="https://example.com"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="clientName">Client name (optional)</Label>
        <Input
          id="clientName"
          placeholder="Acme Roofing"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="industry">Industry (optional)</Label>
        <Input
          id="industry"
          placeholder="Residential roofing"
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="conversionGoal">Primary conversion goal (optional)</Label>
        <Input
          id="conversionGoal"
          placeholder="Book a free roof inspection"
          value={conversionGoal}
          onChange={(e) => setConversionGoal(e.target.value)}
          disabled={submitting}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        These three are optional and only used as context for the AI qualitative assessment
        section of the report — the deterministic scan and scoring run the same either way.
      </p>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting && <Loader2 className="animate-spin" />}
        {submitting ? "Starting scan…" : "Run WII scan"}
      </Button>
    </form>
  );
}
