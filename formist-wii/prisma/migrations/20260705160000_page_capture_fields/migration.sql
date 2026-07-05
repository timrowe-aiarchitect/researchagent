-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "buttons" TEXT[],
ADD COLUMN     "canonical" TEXT,
ADD COLUMN     "external_links" TEXT[],
ADD COLUMN     "forms" JSONB,
ADD COLUMN     "h1" TEXT,
ADD COLUMN     "h2" TEXT[],
ADD COLUMN     "images" JSONB,
ADD COLUMN     "internal_links" TEXT[],
ADD COLUMN     "json_ld" JSONB,
ADD COLUMN     "meta_description" TEXT,
ADD COLUMN     "open_graph" JSONB,
ADD COLUMN     "screenshot_path" TEXT,
ADD COLUMN     "scripts" JSONB,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "word_count" INTEGER;

