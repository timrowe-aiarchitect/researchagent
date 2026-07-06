-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('draft', 'needs_review', 'approved', 'exported');

-- AlterTable
ALTER TABLE "category_scores" ADD COLUMN     "override_score" DOUBLE PRECISION,
ADD COLUMN     "override_rationale" TEXT,
ADD COLUMN     "override_note" TEXT,
ADD COLUMN     "overridden_by" TEXT,
ADD COLUMN     "overridden_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "status" "ReportStatus" NOT NULL DEFAULT 'draft',
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3);
