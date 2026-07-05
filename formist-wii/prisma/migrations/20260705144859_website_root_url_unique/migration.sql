-- DropIndex
DROP INDEX "websites_root_url_idx";

-- CreateIndex
CREATE UNIQUE INDEX "websites_root_url_key" ON "websites"("root_url");
