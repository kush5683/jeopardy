-- AlterTable
ALTER TABLE "ClueResponse" ADD COLUMN "buzzerSessionId" TEXT;

-- AlterTable
ALTER TABLE "BuzzerSession" ADD COLUMN "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "ClueResponse_buzzerSessionId_idx" ON "ClueResponse"("buzzerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BuzzerSession_sessionId_key" ON "BuzzerSession"("sessionId");
