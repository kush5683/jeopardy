-- AlterTable
ALTER TABLE "User" ADD COLUMN "disabledMetaCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Category" ADD COLUMN "metaCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Category_metaCategories_idx" ON "Category" USING GIN ("metaCategories");
