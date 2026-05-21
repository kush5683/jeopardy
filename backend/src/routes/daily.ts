import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { warmWikiCache } from "../lib/warmWikiCache";

export const dailyRouter = Router();

const DAILY_CLUE_COUNT = 30;

function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function dateAtUTC(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

// Mix in JWT_SECRET as a server-side salt so tomorrow's clue IDs can't be
// precomputed from the (public) sha256(dayKey:index) hash alone. The set is
// still deterministic per-day on the server, just not publicly predictable.
const DAILY_SALT = process.env.JWT_SECRET ?? "";

// Hash dayKey + index → number in [1, max]
function pickId(dayKey: string, index: number, maxId: number): number {
  const hash = crypto
    .createHmac("sha256", DAILY_SALT)
    .update(`${dayKey}:${index}`)
    .digest("hex");
  const n = BigInt(`0x${hash.slice(0, 12)}`);
  return Number(n % BigInt(maxId)) + 1;
}

async function getDailyClueIds(dayKey: string): Promise<number[]> {
  const result = await prisma.clue.aggregate({ _max: { id: true } });
  const maxId = result._max.id ?? 0;
  if (maxId === 0) return [];

  // Pick ~2x the count we need to allow for collisions / non-existent ids,
  // then dedupe and trim.
  const candidates: number[] = [];
  for (let i = 0; i < DAILY_CLUE_COUNT * 3; i++) {
    candidates.push(pickId(dayKey, i, maxId));
  }
  const found = await prisma.clue.findMany({
    where: { id: { in: candidates } },
    include: { category: true },
  });
  // Map by id to preserve our deterministic ordering
  const byId = new Map(found.map((c) => [c.id, c]));
  const ordered: number[] = [];
  for (const id of candidates) {
    if (byId.has(id) && !ordered.includes(id)) {
      ordered.push(id);
      if (ordered.length === DAILY_CLUE_COUNT) break;
    }
  }
  return ordered;
}

dailyRouter.get("/today", async (_req, res) => {
  const dayKey = todayKey();
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
// post a fake score. The body is intentionally ignored.
dailyRouter.post("/finish", requireAuth, async (req: AuthedRequest, res) => {
  const dayKey = todayKey();
  const date = dateAtUTC(dayKey);
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
      createdAt: { gte: date },
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
  const dateStr = (req.query.date as string) || todayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
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
  const dayKey = todayKey();
  const date = dateAtUTC(dayKey);
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
      createdAt: { gte: date },
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
