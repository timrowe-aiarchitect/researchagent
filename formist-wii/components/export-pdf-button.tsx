"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ExportPdfButton({ pdfUrl }: { pdfUrl: string | null }) {
  if (pdfUrl) {
    return (
      <Button variant="outline" size="sm" asChild className="print:hidden">
        <a href={pdfUrl} download>
          <Download />
          Export PDF
        </a>
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
      <Download />
      Print / Save as PDF
    </Button>
  );
}
