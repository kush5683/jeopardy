-- CreateEnum
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'ACCEPTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "Round" AS ENUM ('JEOPARDY', 'DOUBLE_JEOPARDY', 'FINAL_JEOPARDY');

-- CreateEnum
CREATE TYPE "PlayMode" AS ENUM ('PRACTICE', 'BUZZER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleId" TEXT,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friendship" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "addresseeId" TEXT NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clue" (
    "id" SERIAL NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "round" "Round" NOT NULL,
    "value" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "airDate" TIMESTAMP(3),
    "dailyDouble" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Clue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClueResponse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clueId" INTEGER NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "responseTimeMs" INTEGER NOT NULL,
    "mode" "PlayMode" NOT NULL,
    "wager" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClueResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuzzerSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalClues" INTEGER NOT NULL,
    "correctCount" INTEGER NOT NULL,
    "avgResponseMs" INTEGER NOT NULL,
    "coryatScore" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuzzerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlashcardDeck" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "FlashcardDeck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flashcard" (
    "id" SERIAL NOT NULL,
    "deckId" INTEGER NOT NULL,
    "front" TEXT NOT NULL,
    "back" TEXT NOT NULL,
    "hint" TEXT,

    CONSTRAINT "Flashcard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFlashcard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "flashcardId" INTEGER NOT NULL,
    "knownLevel" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFlashcard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "Friendship_addresseeId_status_idx" ON "Friendship"("addresseeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Friendship_requesterId_addresseeId_key" ON "Friendship"("requesterId", "addresseeId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Category_name_idx" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Clue_categoryId_idx" ON "Clue"("categoryId");

-- CreateIndex
CREATE INDEX "Clue_round_value_idx" ON "Clue"("round", "value");

-- CreateIndex
CREATE INDEX "ClueResponse_userId_createdAt_idx" ON "ClueResponse"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ClueResponse_clueId_idx" ON "ClueResponse"("clueId");

-- CreateIndex
CREATE INDEX "BuzzerSession_userId_createdAt_idx" ON "BuzzerSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BuzzerSession_coryatScore_idx" ON "BuzzerSession"("coryatScore");

-- CreateIndex
CREATE UNIQUE INDEX "FlashcardDeck_name_key" ON "FlashcardDeck"("name");

-- CreateIndex
CREATE INDEX "Flashcard_deckId_idx" ON "Flashcard"("deckId");

-- CreateIndex
CREATE INDEX "UserFlashcard_userId_knownLevel_idx" ON "UserFlashcard"("userId", "knownLevel");

-- CreateIndex
CREATE UNIQUE INDEX "UserFlashcard_userId_flashcardId_key" ON "UserFlashcard"("userId", "flashcardId");

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_addresseeId_fkey" FOREIGN KEY ("addresseeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clue" ADD CONSTRAINT "Clue_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClueResponse" ADD CONSTRAINT "ClueResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClueResponse" ADD CONSTRAINT "ClueResponse_clueId_fkey" FOREIGN KEY ("clueId") REFERENCES "Clue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuzzerSession" ADD CONSTRAINT "BuzzerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flashcard" ADD CONSTRAINT "Flashcard_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "FlashcardDeck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFlashcard" ADD CONSTRAINT "UserFlashcard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFlashcard" ADD CONSTRAINT "UserFlashcard_flashcardId_fkey" FOREIGN KEY ("flashcardId") REFERENCES "Flashcard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
