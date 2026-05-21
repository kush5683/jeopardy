-- CreateTable
CREATE TABLE "SharedBoard" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedBoard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SharedBoard_code_key" ON "SharedBoard"("code");

-- CreateIndex
CREATE INDEX "SharedBoard_createdAt_idx" ON "SharedBoard"("createdAt");

-- AddForeignKey
ALTER TABLE "SharedBoard" ADD CONSTRAINT "SharedBoard_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
