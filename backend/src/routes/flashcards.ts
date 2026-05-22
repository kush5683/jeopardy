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

/**
 * Handles the GET /decks route or middleware callback.
 *
 * Parameters:
 * - `_req` (`Request<{}, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
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

/**
 * Handles the GET /decks/:id route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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

/**
 * Handles the POST /review route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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
/**
 * Handles the GET /meta-decks route or middleware callback.
 *
 * Parameters:
 * - `_req` (`Request<{}, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
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
 */
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

/**
 * Handles the GET /meta-decks/:name route or middleware callback.
 *
 * Parameters:
 * - `req` (`Request<{ name: string; }, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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
