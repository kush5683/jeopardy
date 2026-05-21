-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlayMode" ADD VALUE 'DAILY';
ALTER TYPE "PlayMode" ADD VALUE 'REVIEW';

-- CreateTable
CREATE TABLE "DailyAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "score" INTEGER NOT NULL,
    "totalCorrect" INTEGER NOT NULL,
    "totalClues" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clueId" INTEGER NOT NULL,
    "nextReviewAt" TIMESTAMP(3) NOT NULL,
    "intervalDays" INTEGER NOT NULL DEFAULT 1,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyAttempt_date_score_idx" ON "DailyAttempt"("date", "score");

-- CreateIndex
CREATE UNIQUE INDEX "DailyAttempt_userId_date_key" ON "DailyAttempt"("userId", "date");

-- CreateIndex
CREATE INDEX "ReviewSchedule_userId_nextReviewAt_idx" ON "ReviewSchedule"("userId", "nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewSchedule_userId_clueId_key" ON "ReviewSchedule"("userId", "clueId");

-- AddForeignKey
ALTER TABLE "DailyAttempt" ADD CONSTRAINT "DailyAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSchedule" ADD CONSTRAINT "ReviewSchedule_clueId_fkey" FOREIGN KEY ("clueId") REFERENCES "Clue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
