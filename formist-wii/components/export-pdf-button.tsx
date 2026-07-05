"use client";

import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";

export function ExportPdfButton() {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} className="print:hidden">
      <Download />
      Export PDF
    </Button>
  );
}
