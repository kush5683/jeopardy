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

/**
 * Handles the GET /due route or middleware callback.
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
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
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

/**
 * Handles the GET /stats route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
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

/**
 * Handles the POST /result route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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
/**
 * Implements the schedule review on wrong function.
 *
 * Parameters:
 * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
 * - `clueId` (`number`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
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
