import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { todayKey } from "../lib/daily";

export const statsRouter = Router();

/**
 * Handles the GET /me route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
statsRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;

  // Aggregate everything in SQL: per-round counts, per-category counts, overall.
  // Previously this pulled every ClueResponse row + included clue and aggregated
  // in JS — O(N) over the wire for a heavy user.
  const [overall, byRoundRows, topCatsRows, buzzer, dailyAttempts] = await Promise.all([
    prisma.$queryRaw<{ total: bigint; correct: bigint }[]>`
      SELECT COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE correct)::bigint AS correct
      FROM "ClueResponse" WHERE "userId" = ${userId}
    `,
    prisma.$queryRaw<{ round: string; total: bigint; correct: bigint }[]>`
      SELECT c.round::text AS round,
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE r.correct)::bigint AS correct
      FROM "ClueResponse" r
      JOIN "Clue" c ON c.id = r."clueId"
      WHERE r."userId" = ${userId}
      GROUP BY c.round
    `,
    prisma.$queryRaw<
      { categoryId: number; name: string; total: bigint; correct: bigint }[]
    >`
      SELECT c."categoryId",
             cat.name,
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE r.correct)::bigint AS correct
      FROM "ClueResponse" r
      JOIN "Clue" c ON c.id = r."clueId"
      JOIN "Category" cat ON cat.id = c."categoryId"
      WHERE r."userId" = ${userId}
      GROUP BY c."categoryId", cat.name
      ORDER BY total DESC
      LIMIT 12
    `,
    prisma.buzzerSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.dailyAttempt.findMany({
      where: { userId },
      orderBy: { date: "desc" },
      take: 365,
    }),
  ]);

  const totalNum = Number(overall[0]?.total ?? 0n);
  const correctNum = Number(overall[0]?.correct ?? 0n);
  const bestCoryat = buzzer.reduce((m, s) => Math.max(m, s.coryatScore), 0);

  const byRound: Record<string, { total: number; correct: number }> = {};
  for (const r of byRoundRows) {
    byRound[r.round] = { total: Number(r.total), correct: Number(r.correct) };
  }

  const topCategories = topCatsRows.map((r) => {
    const total = Number(r.total);
    const correct = Number(r.correct);
    return {
      id: r.categoryId,
      name: r.name,
      total,
      correct,
      accuracy: total ? correct / total : 0,
    };
  });

  const dailyPlayedCount = dailyAttempts.length;
  const dailyBestScore = dailyAttempts.reduce((m, a) => Math.max(m, a.score), 0);
  const dailyScoreSum = dailyAttempts.reduce((sum, a) => sum + a.score, 0);
  const dailyCorrectSum = dailyAttempts.reduce((sum, a) => sum + a.totalCorrect, 0);
  const dailyClueSum = dailyAttempts.reduce((sum, a) => sum + a.totalClues, 0);
  const dailyDates = new Set(
    dailyAttempts.map((a) => a.date.toISOString().slice(0, 10)),
  );
  let dailyStreak = 0;
  let cursor = new Date(`${todayKey()}T00:00:00.000Z`);
  if (!dailyDates.has(cursor.toISOString().slice(0, 10))) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }
  while (dailyDates.has(cursor.toISOString().slice(0, 10))) {
    dailyStreak += 1;
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  }

  res.json({
    totalAnswered: totalNum,
    correctCount: correctNum,
    accuracy: totalNum ? correctNum / totalNum : 0,
    bestCoryat,
    recentBuzzer: buzzer,
    byRound,
    topCategories,
    daily: {
      playedCount: dailyPlayedCount,
      bestScore: dailyBestScore,
      averageScore: dailyPlayedCount ? dailyScoreSum / dailyPlayedCount : 0,
      accuracy: dailyClueSum ? dailyCorrectSum / dailyClueSum : 0,
      streak: dailyStreak,
      recent: dailyAttempts.slice(0, 12).map((attempt) => ({
        id: attempt.id,
        date: attempt.date.toISOString().slice(0, 10),
        score: attempt.score,
        totalCorrect: attempt.totalCorrect,
        totalClues: attempt.totalClues,
        completedAt: attempt.completedAt.toISOString(),
      })),
    },
  });
});
