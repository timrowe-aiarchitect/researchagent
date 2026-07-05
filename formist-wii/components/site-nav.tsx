import Link from "next/link";
import { Gauge, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

export function SiteNav() {
  return (
    <header className="border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 print:hidden">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight">
          <Gauge className="size-5 text-primary" />
          <span>
            Formist <span className="text-muted-foreground font-normal">WII</span>
          </span>
        </Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard">Dashboard</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/scans/new">
              <Plus />
              New scan
            </Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
