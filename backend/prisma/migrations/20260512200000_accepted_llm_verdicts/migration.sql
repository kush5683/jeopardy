-- CreateTable
CREATE TABLE "AcceptedLLMVerdict" (
    "id" SERIAL NOT NULL,
    "canonical" TEXT NOT NULL,
    "submitted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcceptedLLMVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcceptedLLMVerdict_canonical_submitted_key" ON "AcceptedLLMVerdict"("canonical", "submitted");
