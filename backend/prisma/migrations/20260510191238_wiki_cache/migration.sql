-- AlterTable
ALTER TABLE "Clue" ADD COLUMN     "wikiExtract" TEXT,
ADD COLUMN     "wikiFetchedAt" TIMESTAMP(3),
ADD COLUMN     "wikiThumb" TEXT,
ADD COLUMN     "wikiTitle" TEXT,
ADD COLUMN     "wikiUrl" TEXT;
