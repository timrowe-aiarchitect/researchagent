-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DetectedCms" AS ENUM ('wordpress', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('queued', 'crawling', 'scoring', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('success', 'timeout', 'blocked_by_robots', 'error', 'redirect');

-- CreateEnum
CREATE TYPE "EvidenceCategory" AS ENUM ('technical_seo', 'on_page_seo', 'ai_discoverability', 'performance', 'accessibility', 'security', 'analytics', 'wordpress_maintainability', 'brand_experience', 'conversion');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('info', 'minor', 'moderate', 'major', 'critical');

-- CreateEnum
CREATE TYPE "CategoryStatus" AS ENUM ('good', 'needs_attention', 'poor', 'critical');

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "root_url" TEXT NOT NULL,
    "detected_cms" "DetectedCms" NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "pages_requested" INTEGER NOT NULL DEFAULT 25,
    "pages_crawled_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
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
    "scan_id" TEXT NOT NULL,
    "category" "EvidenceCategory" NOT NULL,
    "source" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "finding" TEXT NOT NULL,
    "url" TEXT,
    "raw_data" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_scores" (
    "id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "category" "EvidenceCategory" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "max_score" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "status" "CategoryStatus" NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence_refs" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "priority_rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "category" "EvidenceCategory" NOT NULL,
    "impact" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "evidence_refs" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "scan_id" TEXT NOT NULL,
    "executive_summary" TEXT NOT NULL,
    "full_report" JSONB NOT NULL,
    "html" TEXT NOT NULL,
    "pdf_url" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_root_url_key" ON "clients"("root_url");

-- CreateIndex
CREATE INDEX "scans_client_id_idx" ON "scans"("client_id");

-- CreateIndex
CREATE INDEX "scans_status_idx" ON "scans"("status");

-- CreateIndex
CREATE INDEX "pages_scan_id_idx" ON "pages"("scan_id");

-- CreateIndex
CREATE INDEX "evidence_items_scan_id_category_idx" ON "evidence_items"("scan_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "category_scores_scan_id_category_key" ON "category_scores"("scan_id", "category");

-- CreateIndex
CREATE INDEX "recommendations_scan_id_idx" ON "recommendations"("scan_id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_scan_id_key" ON "reports"("scan_id");

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_scores" ADD CONSTRAINT "category_scores_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

