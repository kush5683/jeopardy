-- Track the intended daily challenge date for DAILY responses. This lets users
-- play older dailies without relying on the wall-clock date of submission.
ALTER TABLE "ClueResponse" ADD COLUMN "dailyDate" DATE;

CREATE INDEX "ClueResponse_userId_dailyDate_idx" ON "ClueResponse"("userId", "dailyDate");
