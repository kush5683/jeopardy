-- AlterTable
ALTER TABLE "Clue" ADD COLUMN     "wikiAliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
