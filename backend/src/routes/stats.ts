import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const statsRouter = Router();

statsRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;

  // Aggregate everything in SQL: per-round counts, per-category counts, overall.
  // Previously this pulled every ClueResponse row + included clue and aggregated
  // in JS — O(N) over the wire for a heavy user.
  const [overall, byRoundRows, topCatsRows, buzzer] = await Promise.all([
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

  res.json({
    totalAnswered: totalNum,
    correctCount: correctNum,
    accuracy: totalNum ? correctNum / totalNum : 0,
    bestCoryat,
    recentBuzzer: buzzer,
    byRound,
    topCategories,
  });
});
