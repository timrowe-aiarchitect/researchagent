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
        body: JSON.stringify({ url }),
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

      {error && <p className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting && <Loader2 className="animate-spin" />}
        {submitting ? "Starting scan…" : "Run WII scan"}
      </Button>
    </form>
  );
}
