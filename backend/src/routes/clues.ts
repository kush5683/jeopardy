import { Router } from "express";
import { z } from "zod";
import { Round, PlayMode } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { scheduleReviewOnWrong } from "./review";
import { fetchWikipedia } from "../lib/wikipedia";
import { getCuratedAliases } from "../lib/curatedAliases";
import { warmWikiCache } from "../lib/warmWikiCache";
import { boardShareLimiter, submitLimiter } from "../middleware/rateLimit";
import { judgeWithLLM, prepareHint, isHintInFlight } from "../lib/llmJudge";
import crypto from "crypto";

export const cluesRouter = Router();

const SHARE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHARE_CODE_LEN = 8;

const KNOWN_META_CATEGORIES = new Set([
  "Geography",
  "US History",
  "World History",
  "Science",
  "Math",
  "Literature",
  "Wordplay",
  "Sports",
  "Entertainment",
  "Food & Drink",
  "Religion",
  "Other",
]);

function parseMetaCategories(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && KNOWN_META_CATEGORIES.has(s));
  // "Everything enabled" is logically equivalent to "no filter" — and during
  // the rollout phase it also lets users see untagged categories until the
  // classifier finishes.
  if (parts.length >= KNOWN_META_CATEGORIES.size) return null;
  return parts;
}

const sharedCellSchema = z.object({
  id: z.number().int().positive(),
  question: z.string().min(1).max(1500),
  value: z.number().int().min(0).max(50000),
  round: z.enum(["JEOPARDY", "DOUBLE_JEOPARDY", "FINAL_JEOPARDY"]),
  category: z.string().min(1).max(200),
  dailyDouble: z.boolean(),
});

const sharedRoundBoardSchema = z.object({
  values: z.array(z.number().int().min(0).max(50000)).length(5),
  categories: z.array(
    z.object({
      name: z.string().min(1).max(200),
      cells: z.array(sharedCellSchema.nullable()).length(5),
    }),
  ).length(6),
});

const sharedEpisodeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jeopardy: sharedRoundBoardSchema,
  doubleJeopardy: sharedRoundBoardSchema,
  finalJeopardy: sharedCellSchema.nullable(),
});

function normalizeShareCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newShareCode(): string {
  const bytes = crypto.randomBytes(SHARE_CODE_LEN);
  let out = "";
  for (let i = 0; i < SHARE_CODE_LEN; i++) {
    out += SHARE_CODE_ALPHABET[bytes[i] % SHARE_CODE_ALPHABET.length];
  }
  return out;
}

async function createSharedBoardCode(
  createdById: string,
  payload: z.infer<typeof sharedEpisodeSchema>,
): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = newShareCode();
    try {
      await prisma.sharedBoard.create({
        data: { code, createdById, payload },
      });
      return code;
    } catch (err: any) {
      if (err?.code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("failed to allocate shared board code");
}

cluesRouter.get("/random", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 5), 50);
  const round = req.query.round as keyof typeof Round | undefined;
  const categoryId = req.query.categoryId
    ? Number(req.query.categoryId)
    : undefined;
  const metaCategories = parseMetaCategories(req.query.metaCategories);

  const where: Record<string, unknown> = {};
  if (round && round in Round) where.round = round;
  if (categoryId) where.categoryId = categoryId;
  if (metaCategories && metaCategories.length > 0) {
    // Subset match: a category only qualifies if every one of its tags is in
    // the user's selection. So "Wordplay only" excludes a hybrid like
    // ["Geography", "Wordplay"] — to see that, the user must also enable
    // Geography. Implemented as NOT(hasSome <complement>) since Prisma lacks
    // a direct "contained by" array operator. Also drops untagged categories
    // so they don't leak through specific filters during the rollout.
    const complement = [...KNOWN_META_CATEGORIES].filter(
      (m) => !metaCategories.includes(m),
    );
    where.category = {
      metaCategories: { isEmpty: false },
      NOT: { metaCategories: { hasSome: complement } },
    };
  }

  const total = await prisma.clue.count({ where });
  if (total === 0) {
    res.json({ clues: [] });
    return;
  }
  // The previous implementation used a single random skip + take=limit, which
  // returned `limit` adjacent rows by primary key — clustering by category
  // after a bulk import. Pick N independent random offsets instead and dedupe.
  // 2× oversampling absorbs duplicate picks without re-rolling.
  const oversample = Math.min(limit * 2, total);
  const skips = Array.from({ length: oversample }, () =>
    Math.floor(Math.random() * total),
  );
  const picks = await Promise.all(
    skips.map((s) =>
      prisma.clue.findFirst({ where, skip: s, include: { category: true } }),
    ),
  );
  const seen = new Map<number, NonNullable<(typeof picks)[number]>>();
  for (const c of picks) {
    if (!c) continue;
    if (seen.size >= limit) break;
    seen.set(c.id, c);
  }
  const clues = [...seen.values()];

  // Fire-and-forget wiki warming so aliases are cached by submit time.
  warmWikiCache(clues);

  res.json({
    clues: clues.map((c) => ({
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

// Weak-category drill — serves clues from the user's worst-performing
// categories. Requires the user to have answered at least MIN_ATTEMPTS in a
// category for it to qualify (avoids noise from one-off mistakes).
cluesRouter.get("/weak", requireAuth, async (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 5), 50);
  const MIN_ATTEMPTS = 3;
  const TOP_WEAK = 8;

  // Aggregate accuracy per category in SQL so we don't pull every response row
  // over the wire. Sorted by accuracy ascending; only categories with at least
  // MIN_ATTEMPTS responses qualify.
  const rows = await prisma.$queryRaw<
    { categoryId: number; total: bigint; correct: bigint }[]
  >`
    SELECT c."categoryId",
           COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE r.correct)::bigint AS correct
    FROM "ClueResponse" r
    JOIN "Clue" c ON c.id = r."clueId"
    WHERE r."userId" = ${req.userId!}
    GROUP BY c."categoryId"
    HAVING COUNT(*) >= ${MIN_ATTEMPTS}
    ORDER BY (COUNT(*) FILTER (WHERE r.correct)::float / COUNT(*)) ASC
    LIMIT ${TOP_WEAK}
  `;
  const weak = rows.map((r) => ({
    id: r.categoryId,
    total: Number(r.total),
    accuracy: Number(r.correct) / Number(r.total),
  }));
  if (weak.length === 0) {
    res.json({ clues: [], weakCategories: [] });
    return;
  }
  const weakIds = weak.map((w) => w.id);
  const total = await prisma.clue.count({ where: { categoryId: { in: weakIds } } });
  const skip = Math.floor(Math.random() * Math.max(1, total - limit));
  const clues = await prisma.clue.findMany({
    where: { categoryId: { in: weakIds } },
    take: limit,
    skip,
    include: { category: true },
  });
  warmWikiCache(clues);

  // Look up names for the weak categories so the frontend can show them.
  const catNames = await prisma.category.findMany({
    where: { id: { in: weakIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(catNames.map((c) => [c.id, c.name]));

  res.json({
    clues: clues.map((c) => ({
      id: c.id,
      question: c.question,
      value: c.value,
      round: c.round,
      dailyDouble: c.dailyDouble,
      airDate: c.airDate,
      category: c.category.name,
    })),
    weakCategories: weak.map((w) => ({
      id: w.id,
      name: nameById.get(w.id) ?? "?",
      accuracy: w.accuracy,
      attempts: w.total,
    })),
  });
});

// Returns a real aired Jeopardy episode's clues — guarantees full board
// coverage (6 categories × 5 values for J! + DJ, plus FJ). Random if no date passed.
cluesRouter.get("/episode", async (req, res) => {
  let dateStr = req.query.date as string | undefined;
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const rows = await prisma.$queryRaw<{ airDate: Date }[]>`
      SELECT "airDate" FROM "Clue"
      WHERE "airDate" IS NOT NULL
      GROUP BY "airDate"
      HAVING COUNT(*) FILTER (WHERE round = 'JEOPARDY') >= 25
         AND COUNT(*) FILTER (WHERE round = 'DOUBLE_JEOPARDY') >= 25
         AND COUNT(*) FILTER (WHERE round = 'FINAL_JEOPARDY') >= 1
      ORDER BY RANDOM()
      LIMIT 1
    `;
    if (rows.length === 0) {
      res.status(404).json({ error: "no eligible episodes" });
      return;
    }
    const d = rows[0].airDate;
    dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  const date = new Date(`${dateStr}T00:00:00Z`);
  const clues = await prisma.clue.findMany({
    where: { airDate: date },
    include: { category: true },
    orderBy: [{ categoryId: "asc" }, { value: "asc" }],
  });

  function buildBoard(roundClues: typeof clues) {
    const byCat = new Map<
      number,
      { category: string; rows: typeof clues }
    >();
    for (const c of roundClues) {
      if (!byCat.has(c.categoryId)) {
        byCat.set(c.categoryId, { category: c.category.name, rows: [] });
      }
      byCat.get(c.categoryId)!.rows.push(c);
    }
    // Determine the 5 value tiers used in this episode for this round
    const allValues = Array.from(new Set(roundClues.map((c) => c.value))).sort(
      (a, b) => a - b,
    );
    const tiers = allValues.slice(0, 5);
    return {
      values: tiers,
      categories: Array.from(byCat.values())
        .slice(0, 6)
        .map((cat) => ({
          name: cat.category,
          cells: tiers.map((v) => {
            const c = cat.rows.find((r) => r.value === v);
            if (!c) return null;
            return {
              id: c.id,
              question: c.question,
              answer: undefined,
              value: c.value,
              round: c.round,
              dailyDouble: c.dailyDouble,
              category: cat.category,
            };
          }),
        })),
    };
  }

  const j = clues.filter((c) => c.round === "JEOPARDY");
  const dj = clues.filter((c) => c.round === "DOUBLE_JEOPARDY");
  const fj = clues.find((c) => c.round === "FINAL_JEOPARDY");

  // Fire-and-forget wiki warming for all clues in the episode
  warmWikiCache(clues);

  res.json({
    date: dateStr,
    jeopardy: buildBoard(j),
    doubleJeopardy: buildBoard(dj),
    finalJeopardy: fj
      ? {
          id: fj.id,
          question: fj.question,
          value: fj.value,
          round: fj.round,
          dailyDouble: fj.dailyDouble,
          category: fj.category.name,
        }
      : null,
  });
});

// Mixed board — 6 random categories per round (each with full value coverage)
// from anywhere in the corpus, plus a random Final Jeopardy. Daily Doubles are
// placed randomly since we don't have the real ones.
cluesRouter.get("/mixed-board", async (_req, res) => {
  const J_VALUES = [200, 400, 600, 800, 1000];
  const DJ_VALUES = [400, 800, 1200, 1600, 2000];

  async function buildRound(round: "JEOPARDY" | "DOUBLE_JEOPARDY", values: number[]) {
    // Pick 6 random categories that have clues at every value tier for this round.
    const rows = await prisma.$queryRaw<{ categoryId: number }[]>`
      SELECT "categoryId"
      FROM "Clue"
      WHERE round = ${round}::"Round" AND value = ANY(${values}::int[])
      GROUP BY "categoryId"
      HAVING COUNT(DISTINCT value) = ${values.length}
      ORDER BY RANDOM()
      LIMIT 6
    `;
    const ids = rows.map((r) => r.categoryId);
    if (ids.length === 0) return { values, categories: [] };

    const clues = await prisma.clue.findMany({
      where: {
        categoryId: { in: ids },
        round,
        value: { in: values },
      },
      include: { category: true },
    });
    // Group: { catId: { value: clue[] } }, pick first per (cat, value).
    const byCat = new Map<
      number,
      { name: string; cells: Map<number, typeof clues[number]> }
    >();
    for (const c of clues) {
      if (!byCat.has(c.categoryId)) {
        byCat.set(c.categoryId, { name: c.category.name, cells: new Map() });
      }
      const entry = byCat.get(c.categoryId)!;
      if (!entry.cells.has(c.value)) entry.cells.set(c.value, c);
    }
    return {
      values,
      categories: ids
        .map((id) => byCat.get(id))
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .map((cat) => ({
          name: cat.name,
          cells: values.map((v) => {
            const c = cat.cells.get(v);
            if (!c) return null;
            return {
              id: c.id,
              question: c.question,
              value: c.value,
              round: c.round,
              dailyDouble: c.dailyDouble,
              category: cat.name,
            };
          }),
        })),
    };
  }

  const [jeopardy, doubleJeopardy, fjRows] = await Promise.all([
    buildRound("JEOPARDY", J_VALUES),
    buildRound("DOUBLE_JEOPARDY", DJ_VALUES),
    prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Clue" WHERE round = 'FINAL_JEOPARDY' ORDER BY RANDOM() LIMIT 1
    `,
  ]);

  let finalJeopardy = null;
  if (fjRows.length > 0) {
    const fj = await prisma.clue.findUnique({
      where: { id: fjRows[0].id },
      include: { category: true },
    });
    if (fj) {
      finalJeopardy = {
        id: fj.id,
        question: fj.question,
        value: fj.value,
        round: fj.round,
        dailyDouble: fj.dailyDouble,
        category: fj.category.name,
      };
    }
  }

  // Clear DD flags inherited from clues' original airings, then sprinkle fresh:
  // 1 DD in J! round, 2 in DJ. Each subsequent DD avoids categories already
  // used by an earlier DD — keeps the placements distributed across the board.
  function sprinkleDDs(board: typeof jeopardy, count: number) {
    let cells: { catIdx: number; cellIdx: number }[] = [];
    board.categories.forEach((cat, ci) => {
      cat.cells.forEach((cell, vi) => {
        if (cell) {
          (cell as { dailyDouble: boolean }).dailyDouble = false;
          cells.push({ catIdx: ci, cellIdx: vi });
        }
      });
    });
    for (let i = 0; i < count && cells.length > 0; i++) {
      const idx = Math.floor(Math.random() * cells.length);
      const { catIdx, cellIdx } = cells[idx];
      const cell = board.categories[catIdx].cells[cellIdx];
      if (cell) (cell as { dailyDouble: boolean }).dailyDouble = true;
      cells = cells.filter((c) => c.catIdx !== catIdx);
    }
  }
  sprinkleDDs(jeopardy, 1);
  sprinkleDDs(doubleJeopardy, 2);

  // Warm wiki cache for the clues we're about to serve.
  const allClues = [
    ...jeopardy.categories.flatMap((c) => c.cells),
    ...doubleJeopardy.categories.flatMap((c) => c.cells),
    finalJeopardy,
  ].filter((c): c is NonNullable<typeof c> => Boolean(c));
  const fullClues = await prisma.clue.findMany({
    where: { id: { in: allClues.map((c) => c.id) } },
    include: { category: true },
  });
  warmWikiCache(fullClues);

  res.json({ jeopardy, doubleJeopardy, finalJeopardy });
});

const boardShareCreateSchema = z.object({
  episode: sharedEpisodeSchema,
});

cluesRouter.post(
  "/board-share",
  boardShareLimiter,
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = boardShareCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const code = await createSharedBoardCode(req.userId!, parsed.data.episode);
    res.json({ code });
  },
);

cluesRouter.get("/board-share/:code", boardShareLimiter, async (req, res) => {
  const code = normalizeShareCode(req.params.code);
  if (!new RegExp(`^[${SHARE_CODE_ALPHABET}]{${SHARE_CODE_LEN}}$`).test(code)) {
    res.status(400).json({ error: "invalid share code" });
    return;
  }
  const share = await prisma.sharedBoard.findUnique({
    where: { code },
    select: { payload: true },
  });
  if (!share) {
    res.status(404).json({ error: "share code not found" });
    return;
  }
  const payload = sharedEpisodeSchema.safeParse(share.payload);
  if (!payload.success) {
    res.status(500).json({ error: "shared board payload invalid" });
    return;
  }
  res.json({ episode: payload.data });
});

cluesRouter.get("/categories", async (_req, res) => {
  const cats = await prisma.category.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  res.json({ categories: cats });
});

const submitSchema = z.object({
  clueId: z.number().int(),
  answer: z.string(),
  responseTimeMs: z.number().int().min(0),
  mode: z.enum(["PRACTICE", "BUZZER", "DAILY", "REVIEW", "BOARD", "FINAL"]),
  wager: z.number().int().nullable().optional(),
  buzzerSessionId: z.string().min(1).max(64).nullable().optional(),
});

// Single-token number-word → digit substitutions. Lets "ten" match "10",
// "five" match "5", etc. Compound numbers ("twenty-four" → "24") aren't
// handled — each word substitutes independently ("twenty four" → "20 4").
// Decade words ("nineties" ↔ "90s") collapse to the same form so users can
// type either when the canonical is the other.
const NUM_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50",
  sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", million: "1000000", billion: "1000000000",
  twenties: "20s", thirties: "30s", forties: "40s", fifties: "50s",
  sixties: "60s", seventies: "70s", eighties: "80s", nineties: "90s",
};

function normalize(s: string): string {
  const base = s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^(what|who|where|when|why|how)\s+(is|are|was|were)\s+/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    // Strip apostrophes so contractions stay as single tokens:
    // "can't" → "cant" (NOT "can t", which would let "can" fuzzy-match "cant").
    .replace(/[‘’']/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Per-token number-word → digit substitution.
  return base.split(" ").map((w) => NUM_WORDS[w] ?? w).join(" ");
}

// Recognizes simple verb-tense / plural relationships between two words so
// "hang" ↔ "hanging", "run" ↔ "running", "marry" ↔ "married" align in the
// phrase matcher. Conservative — only fires on obvious inflections of words
// at least 3 chars long.
function isInflection(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 3) return false;
  const SUF = ["ing", "ed", "es", "s"];
  for (const suf of SUF) {
    if (l === s + suf) return true;
    // doubled-consonant: "run" + "n" + "ing" = "running"
    if ((suf === "ing" || suf === "ed") && l === s + s.slice(-1) + suf) {
      return true;
    }
    // drop-e: "love" → "lov" + "ing" = "loving"
    if (
      (suf === "ing" || suf === "ed") &&
      s.endsWith("e") &&
      l === s.slice(0, -1) + suf
    ) {
      return true;
    }
    // y → i: "marry" → "married" / "marries"
    if (s.endsWith("y") && l === s.slice(0, -1) + "i" + suf) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  "of", "the", "a", "an", "and", "or", "in", "on", "at", "to", "for",
  "is", "are", "was", "were", "be", "by", "with",
]);

// Damerau-Levenshtein: counts adjacent-letter transpositions ("teh"→"the") as distance 1.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Multi-word phrase match: every non-stopword in canonical must have a word
// in submitted that fuzzy-matches (and vice versa). Bidirectional + content-only,
// so "anne cleves" matches "anne of cleves" (drops "of"), but "white men can jump"
// does NOT match "white men cant jump" — "cant" (4-char) requires exact match.
function phraseWordsAlign(a: string, b: string): boolean {
  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);
  if (aWords.length === 0 || bWords.length === 0) return false;
  // Threshold for individual words: stricter than the whole-phrase version.
  // 1-4 chars → exact required; 5+ chars → standard fuzzy.
  function wordT(len: number): number {
    if (len <= 4) return 0;
    return Math.max(1, Math.floor(len / 5));
  }
  function has(w: string, candidates: string[]): boolean {
    const t = wordT(w.length);
    return candidates.some(
      (c) => editDistance(w, c) <= t || isInflection(w, c),
    );
  }
  const aContent = aWords.filter((w) => !STOPWORDS.has(w));
  const bContent = bWords.filter((w) => !STOPWORDS.has(w));
  if (aContent.length === 0 || bContent.length === 0) return false;
  // Each side's content words must be covered by the other side's full word list.
  return (
    bContent.every((w) => has(w, aWords)) && aContent.every((w) => has(w, bWords))
  );
}

function containsAsPhrase(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  // After normalize(), both strings are single-space-separated tokens.
  const h = ` ${haystack} `;
  const n = ` ${needle} `;
  return h.includes(n);
}

function fuzzyThreshold(len: number): number {
  // For very short strings, any "1 edit" is too lenient — "AC" vs "DC" is 1 edit
  // but they mean opposite things. Require exact match below 4 chars.
  if (len <= 3) return 0;
  return Math.max(1, Math.floor(len / 5));
}

function importantWords(s: string): string[] {
  return s
    .split(" ")
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

const MULTI_OPTION_SKIP = new Set([
  "and", "or", "of", "is", "are", "was", "were", "&",
]);

// Handles canonicals like "(2 of) Milan, Turin or Genoa" — user must supply N
// distinct options from the list, and every non-stopword token they provide
// must match one of the listed options (no extras allowed).
// Returns true/false if the pattern applies; null otherwise (caller falls back).
function tryMultiOption(submittedRaw: string, canonicalRaw: string): boolean | null {
  const m = canonicalRaw.match(/^\s*\(?\s*(\d+)\s+of\)?\s+(.*)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const rest = m[2];

  // Parse the option list. Prefer the "A, B or C" pattern; fall back to "A, B, C".
  const orParts = rest.split(/\s+or\s+/i);
  let optionsRaw: string[];
  if (orParts.length >= 2) {
    const last = orParts[orParts.length - 1];
    const head = orParts.slice(0, -1).join(" or ");
    const headParts = head.split(",").map((s) => s.trim()).filter(Boolean);
    optionsRaw = [...headParts, last.trim()];
  } else {
    optionsRaw = rest.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (optionsRaw.length < n) return null;
  const options = optionsRaw
    .map((o) => normalize(o))
    .filter((o) => o.length > 0)
    .map((o) => ({ text: o, words: o.split(" ") }));

  // Tokenize the user input. Strip stopwords + bare digits (so "2 of milan turin" reduces to ["milan","turin"]).
  const userTokens = normalize(submittedRaw)
    .split(" ")
    .filter((t) => t && !MULTI_OPTION_SKIP.has(t) && !/^\d+$/.test(t));
  if (userTokens.length === 0) return false;

  // Greedy span match: longest options first so multi-word options aren't shadowed.
  const sorted = [...options].sort((a, b) => b.words.length - a.words.length);
  const used = new Set<number>();
  let matched = 0;

  for (const opt of sorted) {
    const len = opt.words.length;
    for (let i = 0; i + len <= userTokens.length; i++) {
      let collision = false;
      for (let k = 0; k < len; k++) {
        if (used.has(i + k)) {
          collision = true;
          break;
        }
      }
      if (collision) continue;
      const span = userTokens.slice(i, i + len).join(" ");
      if (editDistance(span, opt.text) <= fuzzyThreshold(opt.text.length)) {
        for (let k = 0; k < len; k++) used.add(i + k);
        matched++;
        break;
      }
    }
  }

  const unmatched = userTokens.length - used.size;
  return matched >= n && unmatched === 0;
}

// Handles canonicals like "Tajikistan & Turkmenistan" or "Lewis & Clark" — every
// part listed must be supplied by the user (order-independent). Doesn't fire on
// "AT&T" / "M&M" style names (no spaces around the ampersand).
function tryAmpersandList(submittedRaw: string, canonicalRaw: string): boolean | null {
  if (!/\s+&\s+/.test(canonicalRaw)) return null;
  const parts = canonicalRaw.split(/\s+&\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // Single-letter list ("A & B", "U & I"): accept any ordering of the letters,
  // with or without separators. "AB" / "B A" / "a, b" all match "A & B".
  // Skip normalize() here — its leading-article strip would eat "A " from "A B".
  const normParts = parts.map((p) => normalize(p));
  if (normParts.every((p) => p.length === 1)) {
    const letters = submittedRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (letters.length !== normParts.length) return false;
    const a = [...letters].sort().join("");
    const b = [...normParts].sort().join("");
    return a === b;
  }
  // Each remaining part must be substantive — drop trivial cases that aren't true lists.
  if (parts.some((p) => normalize(p).length < 3)) return null;

  const options = parts.map((p) => normalize(p)).map((o) => ({ text: o, words: o.split(" ") }));
  const userTokens = normalize(submittedRaw)
    .split(" ")
    .filter((t) => t && !MULTI_OPTION_SKIP.has(t) && !/^\d+$/.test(t));
  if (userTokens.length === 0) return false;

  const sorted = [...options].sort((a, b) => b.words.length - a.words.length);
  const used = new Set<number>();
  let matched = 0;
  for (const opt of sorted) {
    const len = opt.words.length;
    for (let i = 0; i + len <= userTokens.length; i++) {
      let collision = false;
      for (let k = 0; k < len; k++) {
        if (used.has(i + k)) {
          collision = true;
          break;
        }
      }
      if (collision) continue;
      const span = userTokens.slice(i, i + len).join(" ");
      if (editDistance(span, opt.text) <= fuzzyThreshold(opt.text.length)) {
        for (let k = 0; k < len; k++) used.add(i + k);
        matched++;
        break;
      }
    }
  }
  const unmatched = userTokens.length - used.size;
  return matched >= parts.length && unmatched === 0;
}

function extractParentheticals(canonical: string): string[] {
  const out: string[] = [];
  const re = /\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(canonical)) !== null) {
    const inner = m[1].trim();
    if (inner) out.push(inner);
  }
  return out;
}

// Used by decadeAliasesOf — maps the tens digit to its decade word.
const DECADE_WORD_BY_TENS: Record<string, string> = {
  "2": "twenties", "3": "thirties", "4": "forties", "5": "fifties",
  "6": "sixties", "7": "seventies", "8": "eighties", "9": "nineties",
};

// Turn a string containing a 4-digit year-decade ("1990s", "the 1820s") into
// its short and word-form variants so either side of a comparison can use the
// generic form. Returns [] when no year-decade is present. Intentionally
// century-agnostic: "1890s" also yields "nineties" as an alias, which means a
// canonical of "1890s" will accept a user guess of "nineties" — accepted as a
// pragmatic trade-off since the clue text disambiguates the century.
function decadeAliasesOf(s: string): string[] {
  const re = /\b[12]\d([2-9])0'?s\b/i;
  if (!re.test(s)) return [];
  const short = s.replace(/\b[12]\d([2-9])0'?s\b/gi, (_, d: string) => `${d}0s`);
  const word = s.replace(
    /\b[12]\d([2-9])0'?s\b/gi,
    (_, d: string) => DECADE_WORD_BY_TENS[d],
  );
  return [short, word];
}

export function isCorrect(submitted: string, canonical: string, aliases: string[] = []): boolean {
  if (matchAgainst(submitted, canonical)) return true;
  // Canonicals like "alternating current (AC)" explicitly list an abbreviation in parens.
  for (const p of extractParentheticals(canonical)) {
    if (matchAgainst(submitted, p)) return true;
  }
  // Year-decade ↔ generic-decade aliasing: "1990s" / "the 1820s" should match
  // "nineties" / "twenties" (and "90s" / "20s"). Only expand a side when the
  // OTHER side is generic — two specific year-decades like "1990s" vs "1890s"
  // must NOT match (different centuries).
  const submittedHasYear = /\b[12]\d[2-9]0'?s\b/i.test(submitted);
  const canonicalHasYear = /\b[12]\d[2-9]0'?s\b/i.test(canonical);
  if (!submittedHasYear) {
    for (const c of decadeAliasesOf(canonical)) {
      if (matchAgainst(submitted, c)) return true;
    }
  }
  if (!canonicalHasYear) {
    for (const s of decadeAliasesOf(submitted)) {
      if (matchAgainst(s, canonical)) return true;
    }
  }
  // Curated aliases for cases Wikipedia can't help with (TB, US, WWII — abbreviations
  // whose Wikipedia entries are disambiguation pages, not redirects).
  for (const a of getCuratedAliases(canonical)) {
    if (matchAgainst(submitted, a)) return true;
  }
  // Wikipedia-cached redirect aliases for nicknames and variants
  // (e.g. "Teddy Roosevelt" → "Theodore Roosevelt", "Fall" → "Autumn").
  for (const alias of aliases) {
    if (matchAgainst(submitted, alias)) return true;
  }
  return false;
}

function matchAgainst(submitted: string, canonical: string): boolean {
  // "(N of) A, B or C" pattern only applies to the original canonical;
  // aliases won't carry this prefix, but tryMultiOption returns null for them
  // and we fall through to regular matching.
  const multi = tryMultiOption(submitted, canonical);
  if (multi !== null) return multi;
  // "A & B" canonicals require all parts (order-independent). Definitive when triggered.
  const amp = tryAmpersandList(submitted, canonical);
  if (amp !== null) return amp;

  const a = normalize(submitted);
  const b = normalize(canonical);
  if (!a) return false;
  if (a === b) return true;

  // Year-decade tokens like "1990s" / "1890s" are exactly one edit apart but
  // mean different centuries. Suppress fuzzy matching when both sides are
  // year-decades (exact match was already handled above).
  const yearDecadeRe = /^[12]\d[2-9]0s$/;
  if (yearDecadeRe.test(a) && yearDecadeRe.test(b)) return false;

  // Initialism: "jfk" → "John F. Kennedy", "fdr" → "Franklin D. Roosevelt".
  // Also fires when all canonical tokens are single letters ("U.N.", "U.S.", "M.D.")
  // so "UN" matches "the U.N." even though that only yields 2 tokens after normalize.
  const canonicalTokens = b.split(" ").filter((w) => w.length >= 1);
  if (
    canonicalTokens.length >= 3 ||
    (canonicalTokens.length >= 2 && canonicalTokens.every((w) => w.length === 1))
  ) {
    const initialism = canonicalTokens.map((w) => w[0]).join("");
    const submittedJoined = a.replace(/\s+/g, "");
    if (submittedJoined === initialism) return true;
  }

  // Whole-string fuzzy: for SINGLE-word answers, character-level edit distance
  // is fine ("iwoa" → "iowa"). For multi-word phrases it's dangerous — "can"
  // and "cant" differ by one char but mean opposite things. For multi-word
  // canonicals, require word-level coverage instead.
  const aHasSpace = a.includes(" ");
  const bHasSpace = b.includes(" ");
  if (!aHasSpace && !bHasSpace) {
    if (editDistance(a, b) <= fuzzyThreshold(b.length)) return true;
    if (isInflection(a, b)) return true;
  } else if (phraseWordsAlign(a, b)) {
    return true;
  }

  // Compound-word equivalence: "black beard" ↔ "Blackbeard", "ice cream" ↔ "icecream".
  // When exactly one side is a single concatenated word, fuzzy-match the joined
  // form of the other against it. Length-based threshold still applies, so
  // "louis x" → "louisx" won't pull in "louisxiv".
  if (aHasSpace !== bHasSpace) {
    const single = aHasSpace ? b : a;
    const joined = (aHasSpace ? a : b).replace(/ /g, "");
    if (editDistance(joined, single) <= fuzzyThreshold(single.length)) return true;
  }

  // Word-boundary containment. Plain substring matches "louis x" inside "louis xiv"
  // (different French kings); requiring word boundaries fixes that while still
  // accepting "Lincoln" inside "Abraham Lincoln".
  //
  // Guard: when the canonical has 4+ important content words, it's typically a
  // compound pun/wordplay (e.g. "Attorney General Tso's chicken scratch") where
  // a partial 2-word fragment ("chicken scratch") names only one component of
  // several. Suppress containment in that case so the LLM gets to judge whether
  // every component was captured. Legitimate partial-name cases ("Lincoln" for
  // "Abraham Lincoln", "Strait" for "Strait of Gibraltar") have ≤3 important
  // words and are unaffected.
  const bImportantCount = importantWords(b).length;
  if (a.length >= 4 && bImportantCount < 4 && containsAsPhrase(b, a)) return true;
  if (b.length >= 4 && containsAsPhrase(a, b)) return true;

  // Short-canonical case: when canonical/alias is ≤ 3 chars (e.g. "TV", "AC"),
  // accept if any whole user token exactly equals it. Catches "on tv" → "TV",
  // "in ac" → "AC" — common when the user buries the answer in a phrase.
  if (b.length <= 3) {
    for (const sw of a.split(" ")) {
      if (sw === b) return true;
    }
  }

  // Word-level fuzzy: the user must match the *longest* important canonical word
  // (or any of the longest, if tied). That's the distinguishing word — matching only
  // a shorter shared word like "anne" in "Anne of Cleves" doesn't count.
  // Catches "gibralter" vs "Strait of Gibraltar" (key word: gibraltar).
  // Rejects "anne bolin" vs "Anne of Cleves" (key word: cleves).
  //
  // Guard: this fallback is only safe when the user gave a strict *subset*
  // (partial answer) of the canonical. If the user has any non-stopword token
  // that doesn't fuzzy-match a canonical word, we treat that as an explicit
  // wrong guess — reject. Prevents "louis x" / "white men can jump" style
  // false positives where the user's wrong word happens to share a key word
  // with the canonical.
  const aWords = a.split(" ").filter((w) => w.length >= 3);
  const bWords = importantWords(b);
  const aTokens = a.split(" ").filter(Boolean);
  const bTokensAll = b.split(" ").filter(Boolean);
  // Does every non-stopword user token fuzzy-match some canonical word?
  const userHasUnmatchedExtra = aTokens
    .filter((w) => !STOPWORDS.has(w))
    .some((w) => {
      const t = w.length <= 4 ? 0 : Math.max(1, Math.floor(w.length / 5));
      return !bTokensAll.some(
        (bw) => editDistance(w, bw) <= t || isInflection(w, bw),
      );
    });
  // Same compound-canonical guard as the containment branch: when the canonical
  // has 4+ important content words, matching just the longest one isn't enough —
  // the user has only named a fragment of a multi-part answer. Defer to the LLM.
  if (!userHasUnmatchedExtra && bWords.length > 0 && bWords.length < 4) {
    const maxLen = Math.max(...bWords.map((w) => w.length));
    const keyWords = bWords.filter((w) => w.length === maxLen);
    for (const cw of keyWords) {
      const t = fuzzyThreshold(cw.length);
      for (const sw of aWords) {
        if (editDistance(sw, cw) <= t || isInflection(sw, cw)) return true;
      }
    }
  }

  return false;
}

cluesRouter.post("/submit", submitLimiter, requireAuth, async (req: AuthedRequest, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { clueId, answer, responseTimeMs, mode, wager, buzzerSessionId } = parsed.data;
  const clue = await prisma.clue.findUnique({ where: { id: clueId } });
  if (!clue) {
    res.status(404).json({ error: "clue not found" });
    return;
  }
  // A wager is legitimate on a Daily Double, in Final Jeopardy mode, or anywhere
  // in BOARD mode (where DDs in mixed games are sprinkled at request time and
  // aren't reflected in the DB's dailyDouble flag). PRACTICE/BUZZER/DAILY/REVIEW
  // never wager — reject there so a client can't slip a wager into a normal $400
  // clue to inflate their score.
  const wagerAllowed =
    clue.dailyDouble || mode === "FINAL" || mode === "BOARD";
  if (wager != null && !wagerAllowed) {
    res.status(400).json({ error: "wager not allowed for this clue" });
    return;
  }
  let llmVerdict: boolean | null = null;
  let correct = isCorrect(answer, clue.answer, clue.wikiAliases);
  if (!correct) {
    llmVerdict = await judgeWithLLM(clue.question, clue.answer, clue.wikiAliases, answer);
    correct = llmVerdict;
  }
  // Only persist buzzerSessionId for BUZZER-mode responses; ignore for other modes.
  const sessionId = mode === "BUZZER" ? buzzerSessionId ?? null : null;
  const response = await prisma.clueResponse.create({
    data: {
      userId: req.userId!,
      clueId,
      correct,
      responseTimeMs,
      mode: mode as PlayMode,
      wager: wager ?? null,
      buzzerSessionId: sessionId,
    },
  });
  if (!correct) {
    await scheduleReviewOnWrong(req.userId!, clueId);
  }
  res.json({
    responseId: response.id,
    correct,
    canonicalAnswer: clue.answer,
    valueDelta: correct
      ? wager ?? clue.value
      : -(wager ?? clue.value),
    llmVerdict,
  });
});

// Anonymous answer check. Mirrors /submit's correctness logic but doesn't
// require auth, doesn't persist a ClueResponse, and doesn't schedule reviews.
// Lets logged-out users play modes like Daily without an account.
const checkSchema = z.object({
  clueId: z.number().int(),
  answer: z.string(),
});

cluesRouter.post("/check", submitLimiter, async (req, res) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { clueId, answer } = parsed.data;
  const clue = await prisma.clue.findUnique({ where: { id: clueId } });
  if (!clue) {
    res.status(404).json({ error: "clue not found" });
    return;
  }
  let llmVerdict: boolean | null = null;
  let correct = isCorrect(answer, clue.answer, clue.wikiAliases);
  if (!correct) {
    llmVerdict = await judgeWithLLM(clue.question, clue.answer, clue.wikiAliases, answer);
    correct = llmVerdict;
  }
  res.json({ correct, canonicalAnswer: clue.answer, value: clue.value, llmVerdict });
});

cluesRouter.post("/mark-correct/:responseId", requireAuth, async (req: AuthedRequest, res) => {
  const responseId = req.params.responseId;
  const response = await prisma.clueResponse.findUnique({ where: { id: responseId } });
  if (!response || response.userId !== req.userId) {
    res.status(404).json({ error: "response not found" });
    return;
  }
  if (response.correct) {
    res.json({ alreadyCorrect: true });
    return;
  }
  await prisma.clueResponse.update({
    where: { id: responseId },
    data: { correct: true },
  });
  // Drop the review schedule entry since the user attests they knew it.
  await prisma.reviewSchedule.deleteMany({
    where: { userId: req.userId!, clueId: response.clueId },
  });
  const clue = await prisma.clue.findUnique({ where: { id: response.clueId } });
  res.json({
    valueDelta: response.wager ?? clue?.value ?? 0,
  });
});

cluesRouter.post("/mark-incorrect/:responseId", requireAuth, async (req: AuthedRequest, res) => {
  const responseId = req.params.responseId;
  const response = await prisma.clueResponse.findUnique({ where: { id: responseId } });
  if (!response || response.userId !== req.userId) {
    res.status(404).json({ error: "response not found" });
    return;
  }
  if (!response.correct) {
    res.json({ alreadyIncorrect: true });
    return;
  }
  await prisma.clueResponse.update({
    where: { id: responseId },
    data: { correct: false },
  });
  // Re-enroll in review since the user attests they didn't actually know it.
  await scheduleReviewOnWrong(req.userId!, response.clueId);
  const clue = await prisma.clue.findUnique({ where: { id: response.clueId } });
  res.json({
    valueDelta: response.wager ?? clue?.value ?? 0,
  });
});

cluesRouter.get("/:id/wiki", async (req, res) => {
  const clueId = Number(req.params.id);
  if (!Number.isFinite(clueId)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  const clue = await prisma.clue.findUnique({
    where: { id: clueId },
    include: { category: true },
  });
  if (!clue) {
    res.status(404).json({ error: "not found" });
    return;
  }

  if (clue.wikiFetchedAt) {
    res.json({
      title: clue.wikiTitle,
      extract: clue.wikiExtract,
      url: clue.wikiUrl,
      thumb: clue.wikiThumb,
      cached: true,
    });
    return;
  }

  const { ok, transient, data } = await fetchWikipedia(clue.answer, clue.category.name, clue.question);
  if (ok && !transient) {
    await prisma.clue.update({
      where: { id: clueId },
      data: {
        wikiFetchedAt: new Date(),
        wikiTitle: data?.title ?? null,
        wikiExtract: data?.extract ?? null,
        wikiUrl: data?.url ?? null,
        wikiThumb: data?.thumb ?? null,
        wikiAliases: data?.aliases ?? [],
      },
    });
  }
  res.json({
    title: data?.title ?? null,
    extract: data?.extract ?? null,
    url: data?.url ?? null,
    thumb: data?.thumb ?? null,
    cached: false,
  });
});

// Fire-and-forget kickoff for LLM hint generation. The frontend calls this when
// a clue is first shown so the hint is ready (or in progress) by the time the
// user finishes answering. Idempotent: returns 202 immediately whether the hint
// is already cached, currently being generated, or freshly started.
cluesRouter.post("/:id/hint/prepare", async (req, res) => {
  const clueId = parseInt(req.params.id, 10);
  if (!Number.isFinite(clueId)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  const clue = await prisma.clue.findUnique({
    where: { id: clueId },
    select: { id: true, question: true, answer: true, hintFetchedAt: true },
  });
  if (!clue) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!clue.hintFetchedAt) {
    // Don't await — we want the HTTP response to return immediately so the
    // frontend can keep rendering while generation runs in the background.
    void prepareHint(clueId, clue.question, clue.answer, async (hint) => {
      await prisma.clue.update({
        where: { id: clueId },
        data: { hintText: hint, hintFetchedAt: new Date() },
      });
    });
  }
  res.status(202).json({ ok: true });
});

// Returns the current state of a clue's hint. Used by the result panel to
// auto-show the hint when ready, or poll while it's still generating.
cluesRouter.get("/:id/hint", async (req, res) => {
  const clueId = parseInt(req.params.id, 10);
  if (!Number.isFinite(clueId)) {
    res.status(400).json({ error: "bad id" });
    return;
  }
  const clue = await prisma.clue.findUnique({
    where: { id: clueId },
    select: { hintText: true, hintFetchedAt: true },
  });
  if (!clue) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (clue.hintFetchedAt) {
    res.json({ status: "ready", hint: clue.hintText });
    return;
  }
  res.json({ status: isHintInFlight(clueId) ? "pending" : "not_started", hint: null });
});
