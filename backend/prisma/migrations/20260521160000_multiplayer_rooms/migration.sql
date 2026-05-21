-- CreateEnum
CREATE TYPE "MultiplayerRoomStatus" AS ENUM ('LOBBY', 'LIVE', 'FINAL', 'COMPLETE', 'ABANDONED');

-- CreateTable
CREATE TABLE "MultiplayerRoom" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "status" "MultiplayerRoomStatus" NOT NULL DEFAULT 'LOBBY',
    "boardPayload" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MultiplayerRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MultiplayerPlayer" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "MultiplayerPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MultiplayerRoom_code_key" ON "MultiplayerRoom"("code");

-- CreateIndex
CREATE INDEX "MultiplayerRoom_hostUserId_createdAt_idx" ON "MultiplayerRoom"("hostUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MultiplayerRoom_status_createdAt_idx" ON "MultiplayerRoom"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MultiplayerPlayer_roomId_userId_key" ON "MultiplayerPlayer"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MultiplayerPlayer_roomId_seat_key" ON "MultiplayerPlayer"("roomId", "seat");

-- CreateIndex
CREATE INDEX "MultiplayerPlayer_userId_joinedAt_idx" ON "MultiplayerPlayer"("userId", "joinedAt");

-- AddForeignKey
ALTER TABLE "MultiplayerRoom" ADD CONSTRAINT "MultiplayerRoom_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplayerPlayer" ADD CONSTRAINT "MultiplayerPlayer_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "MultiplayerRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MultiplayerPlayer" ADD CONSTRAINT "MultiplayerPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
