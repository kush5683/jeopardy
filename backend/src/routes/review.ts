import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const reviewRouter = Router();

// Lightweight FSRS-style scheduler.
// Wrong: nextReview = tomorrow, intervalDays = 1
// Correct: intervalDays *= 2.5 (capped at 90), nextReview = today + intervalDays
const INTERVAL_GROWTH = 2.5;
const MAX_INTERVAL_DAYS = 90;

reviewRouter.get("/due", requireAuth, async (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const now = new Date();
  const schedules = await prisma.reviewSchedule.findMany({
    where: { userId: req.userId!, nextReviewAt: { lte: now } },
    orderBy: { nextReviewAt: "asc" },
    take: limit,
    include: { clue: { include: { category: true } } },
  });
  res.json({
    clues: schedules.map((s) => ({
      id: s.clue.id,
      question: s.clue.question,
      value: s.clue.value,
      round: s.clue.round,
      dailyDouble: s.clue.dailyDouble,
      category: s.clue.category.name,
      reviewCount: s.reviewCount,
      intervalDays: s.intervalDays,
    })),
  });
});

reviewRouter.get("/stats", requireAuth, async (req: AuthedRequest, res) => {
  const now = new Date();
  const [due, total, scheduled] = await Promise.all([
    prisma.reviewSchedule.count({
      where: { userId: req.userId!, nextReviewAt: { lte: now } },
    }),
    prisma.reviewSchedule.count({ where: { userId: req.userId! } }),
    prisma.reviewSchedule.findMany({
      where: { userId: req.userId!, nextReviewAt: { gt: now } },
      orderBy: { nextReviewAt: "asc" },
      take: 1,
    }),
  ]);
  res.json({
    due,
    total,
    nextReviewAt: scheduled[0]?.nextReviewAt ?? null,
  });
});

const resultSchema = z.object({
  clueId: z.number().int(),
  correct: z.boolean(),
});

reviewRouter.post("/result", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = resultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { clueId, correct } = parsed.data;
  const existing = await prisma.reviewSchedule.findUnique({
    where: { userId_clueId: { userId: req.userId!, clueId } },
  });
  const now = new Date();

  let intervalDays: number;
  if (correct) {
    const base = existing?.intervalDays ?? 1;
    intervalDays = Math.min(MAX_INTERVAL_DAYS, Math.round(base * INTERVAL_GROWTH));
  } else {
    intervalDays = 1;
  }
  const nextReviewAt = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);

  const schedule = await prisma.reviewSchedule.upsert({
    where: { userId_clueId: { userId: req.userId!, clueId } },
    create: {
      userId: req.userId!,
      clueId,
      nextReviewAt,
      intervalDays,
      reviewCount: 1,
    },
    update: {
      nextReviewAt,
      intervalDays,
      reviewCount: { increment: 1 },
    },
  });
  res.json({ schedule });
});

// Helper called from /clues/submit to enroll a wrong clue into the review queue.
export async function scheduleReviewOnWrong(userId: string, clueId: number) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await prisma.reviewSchedule.upsert({
    where: { userId_clueId: { userId, clueId } },
    create: {
      userId,
      clueId,
      nextReviewAt: tomorrow,
      intervalDays: 1,
    },
    update: {
      nextReviewAt: tomorrow,
      intervalDays: 1,
    },
  });
}
