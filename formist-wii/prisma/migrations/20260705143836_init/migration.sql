-- CreateEnum
CREATE TYPE "DetectedCms" AS ENUM ('wordpress', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'crawling', 'scoring', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('success', 'timeout', 'blocked_by_robots', 'error', 'redirect');

-- CreateEnum
CREATE TYPE "EvidenceCategory" AS ENUM ('technical_seo', 'on_page_seo', 'ai_discoverability', 'performance', 'accessibility', 'security', 'analytics', 'wordpress_maintainability', 'brand_experience', 'conversion');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('info', 'minor', 'moderate', 'major', 'critical');

-- CreateEnum
CREATE TYPE "BusinessRisk" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('A', 'B', 'C', 'D', 'F');

-- CreateTable
CREATE TABLE "websites" (
    "id" TEXT NOT NULL,
    "root_url" TEXT NOT NULL,
    "detected_cms" "DetectedCms" NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "website_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "pages_requested" INTEGER NOT NULL DEFAULT 25,
    "pages_crawled_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "http_status" INTEGER,
    "crawl_status" "CrawlStatus" NOT NULL,
    "final_url" TEXT,
    "rendered" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "page_id" TEXT,
    "category" "EvidenceCategory" NOT NULL,
    "check_name" TEXT NOT NULL,
    "observed_value" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "recommendation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_scores" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "category" "EvidenceCategory" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "grade" "Grade" NOT NULL,
    "business_risk" "BusinessRisk" NOT NULL,
    "ai_readiness" DOUBLE PRECISION NOT NULL,
    "executive_summary" TEXT NOT NULL,
    "recommendations" TEXT[],
    "methodology_note" TEXT NOT NULL,
    "pdf_url" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roadmap_items" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "priority_rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" "EvidenceCategory" NOT NULL,
    "impact" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "linked_evidence_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roadmap_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "websites_root_url_idx" ON "websites"("root_url");

-- CreateIndex
CREATE INDEX "runs_website_id_idx" ON "runs"("website_id");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE INDEX "pages_run_id_idx" ON "pages"("run_id");

-- CreateIndex
CREATE INDEX "evidence_items_run_id_category_idx" ON "evidence_items"("run_id", "category");

-- CreateIndex
CREATE INDEX "evidence_items_page_id_idx" ON "evidence_items"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_scores_run_id_category_key" ON "category_scores"("run_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "reports_run_id_key" ON "reports"("run_id");

-- CreateIndex
CREATE INDEX "roadmap_items_report_id_idx" ON "roadmap_items"("report_id");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_scores" ADD CONSTRAINT "category_scores_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roadmap_items" ADD CONSTRAINT "roadmap_items_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
