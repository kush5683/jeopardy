// Runs once per test file (before its imports). Set DATABASE_URL here BEFORE
// any test imports src/lib/prisma — the PrismaClient is instantiated at module
// load and reads DATABASE_URL from env at that point.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgresql://jeopardy:966a1498ce8c2f7d531fa470518d0fde@127.0.0.1:5433/jeopardy_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-not-for-prod";
process.env.NODE_ENV = "test";

import { execSync } from "child_process";
import { beforeAll, beforeEach } from "vitest";

// Migrate once per test process. Vitest is configured to run all files in a
// single fork, so this runs exactly once.
let migrated = false;
beforeAll(() => {
  if (migrated) return;
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  migrated = true;
});

// Wipe all user-generated rows between tests. Categories/Clues/FlashcardDeck
// are reference data; tests that need them seed explicitly.
beforeEach(async () => {
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ClueResponse",
      "BuzzerSession",
      "DailyAttempt",
      "ReviewSchedule",
      "UserFlashcard",
      "SharedBoard",
      "Friendship",
      "User",
      "Clue",
      "Category",
      "Flashcard",
      "FlashcardDeck"
    RESTART IDENTITY CASCADE;
  `);
});
