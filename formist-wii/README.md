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
- BullMQ + Redis for the scan job queue
- Zod for request validation

## Local setup

1. Copy `.env.example` to `.env` and point `DATABASE_URL`/`REDIS_URL` at a local Postgres and
   Redis instance.
2. Install dependencies: `npm install` (runs `prisma generate` via `postinstall`).
3. Apply migrations: `npm run db:migrate`.
4. Run the web app: `npm run dev`.
5. In a second terminal, run the scan worker: `npm run worker`.

Scans won't progress past `queued` unless the worker is running — the `/api/scans/[id]/run`
route only enqueues the BullMQ job.

## How a scan flows

1. `POST /api/scans` — validates the URL (must be a public http(s) address; rejects
   localhost/private-network hosts), creates/reuses a `Website` row by root URL, and creates a
   `Run` (status `queued`).
2. `POST /api/scans/[id]/run` — enqueues a BullMQ job for that run.
3. The worker (`worker/scan-worker.ts`) picks up the job and runs the pipeline in
   `lib/scan-pipeline.ts`: crawls up to 25 pages breadth-first from the homepage, collects
   evidence across all 10 WII categories, scores each category and the overall index
   (`lib/scoring.ts`), and writes a `Report` + prioritized `RoadmapItem`s.
4. `GET /api/scans/[id]` — poll for status (`queued` → `crawling` → `scoring` → `complete`/`failed`).
5. `GET /api/reports/[id]` — the full report payload once complete.

## Pages

- `/dashboard` — recent scans across all websites.
- `/scans/new` — submit a URL to start a scan.
- `/scans/[id]` — live crawl progress; redirects to the report on completion.
- `/reports/[id]` — the full WII report (score, grade, business risk, AI readiness, category
  evidence, roadmap, recommendations). Has a print-to-PDF export button.

## Known MVP limitations

- The crawler uses plain `fetch` + regex-based HTML parsing, not a headless browser — it won't
  see content that only renders after client-side JavaScript runs.
- PDF export is browser print-to-PDF (`window.print()` with print-specific styling), not a
  server-rendered PDF file.
- WordPress plugin/version checks are based on public markup only (no vulnerability database
  lookup).
