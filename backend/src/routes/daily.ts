import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { warmWikiCache } from "../lib/warmWikiCache";
import {
  dateAtUTC,
  dateIsInFuture,
  getDailyClueIds,
  nextDateAtUTC,
  normalizeDailyDate,
  todayKey,
} from "../lib/daily";

export const dailyRouter = Router();

function requestedDayKey(value: unknown): string | null {
  if (value != null && normalizeDailyDate(value) === null) return null;
  const dayKey = normalizeDailyDate(value) ?? todayKey();
  if (dateIsInFuture(dayKey)) return null;
  return dayKey;
}

dailyRouter.get("/today", async (req, res) => {
  const dayKey = requestedDayKey(req.query.date);
  if (!dayKey) {
    res.status(400).json({ error: "invalid daily date" });
    return;
  }
  const ids = await getDailyClueIds(dayKey);
  const clues = await prisma.clue.findMany({
    where: { id: { in: ids } },
    include: { category: true },
  });
  const byId = new Map(clues.map((c) => [c.id, c]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  // Background-fetch wiki data for any uncached clues so aliases are ready by
  // submit time. Shared helper dedupes in-flight fetches across requests.
  warmWikiCache(ordered);

  res.json({
    date: dayKey,
    clues: ordered.map((c) => ({
      id: c.id,
      question: c.question,
      value: c.value,
      round: c.round,
      dailyDouble: c.dailyDouble,
      airDate: c.airDate,
      category: c.category.name,
    })),
  });
});

// Server-authoritative: recompute from ClueResponse rows so the client can't
// post a fake score. The body only chooses the daily date.
dailyRouter.post("/finish", requireAuth, async (req: AuthedRequest, res) => {
  const dayKey = requestedDayKey(req.body?.date);
  if (!dayKey) {
    res.status(400).json({ error: "invalid daily date" });
    return;
  }
  const date = dateAtUTC(dayKey);
  const nextDate = nextDateAtUTC(dayKey);
  const clueIds = await getDailyClueIds(dayKey);
  if (clueIds.length === 0) {
    res.status(409).json({ error: "no daily clues for today" });
    return;
  }
  const responses = await prisma.clueResponse.findMany({
    where: {
      userId: req.userId!,
      mode: "DAILY",
      clueId: { in: clueIds },
      OR: [
        { dailyDate: date },
        { dailyDate: null, createdAt: { gte: date, lt: nextDate } },
      ],
    },
    include: { clue: { select: { value: true } } },
  });
  // Dedupe: a clue could have multiple responses (e.g. mark-correct/incorrect
  // toggles update the row in place, but if a row was somehow created twice we
  // take the latest one). Sort desc by createdAt and pick first per clueId.
  const byClue = new Map<number, (typeof responses)[number]>();
  for (const r of [...responses].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )) {
    if (!byClue.has(r.clueId)) byClue.set(r.clueId, r);
  }
  const final = Array.from(byClue.values());
  const totalCorrect = final.filter((r) => r.correct).length;
  const score = final.reduce(
    (s, r) => s + (r.correct ? r.clue.value : -r.clue.value),
    0,
  );
  const attempt = await prisma.dailyAttempt.upsert({
    where: { userId_date: { userId: req.userId!, date } },
    create: {
      userId: req.userId!,
      date,
      score,
      totalCorrect,
      totalClues: clueIds.length,
    },
    update: { score, totalCorrect, totalClues: clueIds.length },
  });
  res.json({ attempt });
});

dailyRouter.get("/leaderboard", async (req, res) => {
  const dateStr = requestedDayKey(req.query.date);
  if (!dateStr) {
    res.status(400).json({ error: "invalid date" });
    return;
  }
  const date = dateAtUTC(dateStr);
  const attempts = await prisma.dailyAttempt.findMany({
    where: { date, user: { isTestAccount: false } },
    orderBy: [{ score: "desc" }, { completedAt: "asc" }],
    take: 50,
    include: { user: { select: { id: true, displayName: true } } },
  });
  res.json({
    date: dateStr,
    rows: attempts.map((a) => ({
      userId: a.user.id,
      displayName: a.user.displayName,
      score: a.score,
      totalCorrect: a.totalCorrect,
      totalClues: a.totalClues,
      completedAt: a.completedAt,
    })),
  });
});

dailyRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const dayKey = requestedDayKey(req.query.date);
  if (!dayKey) {
    res.status(400).json({ error: "invalid daily date" });
    return;
  }
  const date = dateAtUTC(dayKey);
  const nextDate = nextDateAtUTC(dayKey);
  const attempt = await prisma.dailyAttempt.findUnique({
    where: { userId_date: { userId: req.userId!, date } },
  });
  if (attempt) {
    res.json({ attempt, progress: null });
    return;
  }
  // Mid-game resume: derive next index + running score from ClueResponse rows
  // already written for today's daily clue set. Matches /finish's filter so the
  // numbers stay consistent if the user completes the round.
  const clueIds = await getDailyClueIds(dayKey);
  if (clueIds.length === 0) {
    res.json({ attempt: null, progress: null });
    return;
  }
  const responses = await prisma.clueResponse.findMany({
    where: {
      userId: req.userId!,
      mode: "DAILY",
      clueId: { in: clueIds },
      OR: [
        { dailyDate: date },
        { dailyDate: null, createdAt: { gte: date, lt: nextDate } },
      ],
    },
    include: { clue: { select: { value: true } } },
  });
  const byClue = new Map<number, (typeof responses)[number]>();
  for (const r of [...responses].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )) {
    if (!byClue.has(r.clueId)) byClue.set(r.clueId, r);
  }
  const answeredInOrder = clueIds
    .map((id) => byClue.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (answeredInOrder.length === 0) {
    res.json({ attempt: null, progress: null });
    return;
  }
  const score = answeredInOrder.reduce(
    (s, r) => s + (r.correct ? r.clue.value : -r.clue.value),
    0,
  );
  const correctCount = answeredInOrder.filter((r) => r.correct).length;
  res.json({
    attempt: null,
    progress: {
      idx: answeredInOrder.length,
      score,
      correctCount,
    },
  });
});
