import { PrismaClient, Round } from "@prisma/client";
import cluesData from "./clues.json";
import flashcardsData from "./flashcards.json";

const prisma = new PrismaClient();

type ClueRow = {
  category: string;
  round: keyof typeof Round;
  value: number;
  question: string;
  answer: string;
};

type DeckRow = {
  deck: string;
  description: string;
  cards: { front: string; back: string; hint?: string }[];
};

/**
 * Implements the main function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
async function main() {
  console.log("seeding clues...");
  const clues = cluesData as ClueRow[];
  const categoryNames = Array.from(new Set(clues.map((c) => c.category)));
  for (const name of categoryNames) {
    await prisma.category.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }
  const cats = await prisma.category.findMany();
  const catMap = new Map(cats.map((c) => [c.name, c.id]));

  for (const c of clues) {
    const categoryId = catMap.get(c.category);
    if (!categoryId) continue;
    const exists = await prisma.clue.findFirst({
      where: { question: c.question, categoryId },
    });
    if (exists) continue;
    await prisma.clue.create({
      data: {
        categoryId,
        round: c.round as Round,
        value: c.value,
        question: c.question,
        answer: c.answer,
      },
    });
  }
  console.log(`seeded ${clues.length} clues across ${categoryNames.length} categories`);

  console.log("seeding flashcards...");
  const decks = flashcardsData as DeckRow[];
  for (const d of decks) {
    const deck = await prisma.flashcardDeck.upsert({
      where: { name: d.deck },
      create: { name: d.deck, description: d.description },
      update: { description: d.description },
    });
    for (const card of d.cards) {
      const exists = await prisma.flashcard.findFirst({
        where: { deckId: deck.id, front: card.front },
      });
      if (exists) continue;
      await prisma.flashcard.create({
        data: {
          deckId: deck.id,
          front: card.front,
          back: card.back,
          hint: card.hint || null,
        },
      });
    }
  }
  console.log(`seeded ${decks.length} flashcard decks`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
