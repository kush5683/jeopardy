import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth, optionalAuth } from "../middleware/auth";

export const flashcardsRouter = Router();

// Fixed set of meta-categories. Mirrors the rubric used by the tagger.
const META_CATEGORIES = [
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
];
const META_SET = new Set(META_CATEGORIES);

flashcardsRouter.get("/decks", async (_req, res) => {
  const decks = await prisma.flashcardDeck.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { cards: true } } },
  });
  res.json({
    decks: decks.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      cardCount: d._count.cards,
    })),
  });
});

flashcardsRouter.get(
  "/decks/:id",
  optionalAuth,
  async (req: AuthedRequest, res) => {
    const deckId = Number(req.params.id);
    const deck = await prisma.flashcardDeck.findUnique({
      where: { id: deckId },
      include: { cards: true },
    });
    if (!deck) {
      res.status(404).json({ error: "deck not found" });
      return;
    }
    let progressByCard: Record<number, { knownLevel: number; reviewCount: number }> =
      {};
    if (req.userId) {
      const progress = await prisma.userFlashcard.findMany({
        where: { userId: req.userId, flashcardId: { in: deck.cards.map((c) => c.id) } },
      });
      progressByCard = Object.fromEntries(
        progress.map((p) => [p.flashcardId, { knownLevel: p.knownLevel, reviewCount: p.reviewCount }]),
      );
    }
    res.json({
      deck: {
        id: deck.id,
        name: deck.name,
        description: deck.description,
        cards: deck.cards.map((c) => ({
          id: c.id,
          front: c.front,
          back: c.back,
          hint: c.hint,
          progress: progressByCard[c.id] || { knownLevel: 0, reviewCount: 0 },
        })),
      },
    });
  },
);

const reviewSchema = z.object({
  flashcardId: z.number().int(),
  knownLevel: z.number().int().min(0).max(5),
});

flashcardsRouter.post(
  "/review",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { flashcardId, knownLevel } = parsed.data;
    const result = await prisma.userFlashcard.upsert({
      where: {
        userId_flashcardId: { userId: req.userId!, flashcardId },
      },
      create: {
        userId: req.userId!,
        flashcardId,
        knownLevel,
        reviewCount: 1,
      },
      update: {
        knownLevel,
        reviewCount: { increment: 1 },
        lastReviewedAt: new Date(),
      },
    });
    res.json({ progress: result });
  },
);

// Auto-generated decks from the clue corpus, grouped by meta-category.
// Each meta-category becomes a "deck" whose cards are random clues drawn from
// any Category tagged with that meta. Cards aren't persisted as Flashcards,
// so progress isn't tracked.
flashcardsRouter.get("/meta-decks", async (_req, res) => {
  const rows = await prisma.$queryRaw<{ meta: string; count: bigint }[]>`
    SELECT unnest(cat."metaCategories") AS meta,
           COUNT(*)::bigint AS count
    FROM "Clue" c
    JOIN "Category" cat ON cat.id = c."categoryId"
    WHERE array_length(cat."metaCategories", 1) > 0
    GROUP BY meta
  `;
  const byName = new Map(rows.map((r) => [r.meta, Number(r.count)]));
  res.json({
    decks: META_CATEGORIES.map((name) => ({
      name,
      cardCount: byName.get(name) ?? 0,
    })).filter((d) => d.cardCount > 0),
  });
});

flashcardsRouter.get("/meta-decks/:name", async (req, res) => {
  const name = req.params.name;
  if (!META_SET.has(name)) {
    res.status(404).json({ error: "unknown meta category" });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  // ORDER BY RANDOM() is acceptable here: even Geography (the largest bucket)
  // is at most a few hundred K rows; this runs in well under a second on the
  // existing GIN index for metaCategories.
  const rows = await prisma.$queryRaw<
    { id: number; question: string; answer: string; value: number; categoryName: string }[]
  >`
    SELECT c.id, c.question, c.answer, c.value, cat.name AS "categoryName"
    FROM "Clue" c
    JOIN "Category" cat ON cat.id = c."categoryId"
    WHERE ${name} = ANY(cat."metaCategories")
    ORDER BY RANDOM()
    LIMIT ${limit}
  `;
  res.json({
    deck: {
      name,
      description: `${rows.length} random clues from ${name}`,
      cards: rows.map((r) => ({
        id: r.id,
        front: r.question,
        back: r.answer,
        hint: r.categoryName,
      })),
    },
  });
});
