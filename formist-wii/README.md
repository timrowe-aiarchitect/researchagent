# Formist WII — Website Intelligence Index

Internal Formist Studio tool. Enter a public website URL, crawl up to 25 pages, and get a
scored, evidence-backed Website Intelligence Index report with a priority roadmap and a
client-ready PDF export.

See [`docs/PRD-website-intelligence-index-mvp.md`](../docs/PRD-website-intelligence-index-mvp.md)
in the repo root for the full product spec (scoring model, data model, acceptance criteria).

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- shadcn/ui-style components (hand-written; `ui.shadcn.com` isn't reachable from this
  environment's egress policy, so components live directly in `components/ui`)
- Prisma + Postgres (Prisma 7, `prisma-client` generator with the `@prisma/adapter-pg` driver
  adapter — see `lib/prisma.ts`)
- Playwright for the crawler (rendered HTML, screenshots) — see `lib/crawler-service.ts`
- BullMQ + Redis for the scan job queue
- Zod for request validation
- Vitest for tests

## Local setup

1. Copy `.env.example` to `.env` and point `DATABASE_URL`/`REDIS_URL` at a local Postgres and
   Redis instance. If your installed `playwright` package version doesn't match a Chromium
   build already on disk (common in locked-down sandboxes), also set
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to that browser's binary.
2. Install dependencies: `npm install` (runs `prisma generate` via `postinstall`).
3. Apply migrations: `npm run db:migrate`.
4. Run the web app: `npm run dev`.
5. In a second terminal, run the scan worker: `npm run worker`.
6. Run tests: `npm test` (needs a reachable Postgres — the crawler tests persist to and clean
   up from the real `Page`/`Scan`/`Client` tables).

Scans won't progress past `queued` unless the worker is running — the `/api/scans/[id]/run`
route only enqueues the BullMQ job.

## How a scan flows

1. `POST /api/scans` — validates the URL (must be a public http(s) address; rejects
   localhost/private-network hosts), creates/reuses a `Client` row by root URL, and creates a
   `Scan` (status `queued`).
2. `POST /api/scans/[id]/run` — enqueues a BullMQ job for that scan.
3. The worker (`worker/scan-worker.ts`) picks up the job and runs the pipeline in
   `lib/scan-pipeline.ts`:
   - `lib/crawler-service.ts` crawls up to 25 same-domain pages via Playwright, prioritizing the
     homepage, top-nav links, footer links, keyword pages (about/contact/services/offering/
     pricing/blog), then sitemap.xml entries, then everything else discovered. Each page is
     rendered, its data captured (title, meta, headings, word count, links, images, forms,
     buttons, JSON-LD, Open Graph, scripts, a full-page screenshot under `public/screenshots/`),
     rate-limited between requests, and persisted as a `Page` row immediately.
   - the pipeline turns that captured data into `EvidenceItem`s across all 10 WII categories,
     scores each category and the overall index (`lib/scoring.ts`), and writes a `Report` +
     prioritized `Recommendation`s.
4. `GET /api/scans/[id]` — poll for status (`queued` → `crawling` → `scoring` → `complete`/`failed`).
5. `GET /api/reports/[id]` — the full report payload once complete.

## Pages

- `/dashboard` — recent scans across all websites.
- `/scans/new` — submit a URL to start a scan.
- `/scans/[id]` — live crawl progress; redirects to the report on completion.
- `/reports/[id]` — the full WII report (score, grade, business risk, AI readiness, category
  evidence, roadmap, recommendations). Has a print-to-PDF export button.

## Known MVP limitations

- PDF export is browser print-to-PDF (`window.print()` with print-specific styling), not a
  server-rendered PDF file.
- WordPress plugin/version checks are based on public markup only (no vulnerability database
  lookup).
- robots.txt handling only checks for a wildcard (`User-agent: *`) disallow-all rule; per-path
  disallow rules aren't enforced against individual crawl candidates yet.
