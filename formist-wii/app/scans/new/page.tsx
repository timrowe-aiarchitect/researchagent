import { NewScanForm } from "@/components/new-scan-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function NewScanPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New scan</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Enter a public website URL to generate a Website Intelligence Index report.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Website URL</CardTitle>
          <CardDescription>
            We&apos;ll crawl up to 25 public pages starting from the homepage. This can take a
            few minutes depending on site size.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-6">
          <NewScanForm />
        </CardContent>
      </Card>
    </div>
  );
}
