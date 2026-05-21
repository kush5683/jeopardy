import { z } from "zod";
import { Round } from "@prisma/client";
import { prisma } from "./prisma";
import { warmWikiCache } from "./warmWikiCache";

export const sharedCellSchema = z.object({
  id: z.number().int().positive(),
  question: z.string().min(1).max(1500),
  value: z.number().int().min(0).max(50000),
  round: z.enum(["JEOPARDY", "DOUBLE_JEOPARDY", "FINAL_JEOPARDY"]),
  category: z.string().min(1).max(200),
  dailyDouble: z.boolean(),
});

export const sharedRoundBoardSchema = z.object({
  values: z.array(z.number().int().min(0).max(50000)).length(5),
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        cells: z.array(sharedCellSchema.nullable()).length(5),
      }),
    )
    .length(6),
});

export const sharedEpisodeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jeopardy: sharedRoundBoardSchema,
  doubleJeopardy: sharedRoundBoardSchema,
  finalJeopardy: sharedCellSchema.nullable(),
});

export type SharedCell = z.infer<typeof sharedCellSchema>;
export type SharedRoundBoard = z.infer<typeof sharedRoundBoardSchema>;
export type SharedEpisode = z.infer<typeof sharedEpisodeSchema>;

function buildRoundBoard(
  roundClues: Array<{
    id: number;
    question: string;
    value: number;
    round: Round;
    dailyDouble: boolean;
    categoryId: number;
    category: { name: string };
  }>,
): SharedRoundBoard {
  const byCategory = new Map<
    number,
    { category: string; rows: typeof roundClues }
  >();
  for (const clue of roundClues) {
    if (!byCategory.has(clue.categoryId)) {
      byCategory.set(clue.categoryId, {
        category: clue.category.name,
        rows: [],
      });
    }
    byCategory.get(clue.categoryId)!.rows.push(clue);
  }
  const values = Array.from(new Set(roundClues.map((c) => c.value)))
    .sort((a, b) => a - b)
    .slice(0, 5);
  return {
    values,
    categories: Array.from(byCategory.values())
      .slice(0, 6)
      .map((category) => ({
        name: category.category,
        cells: values.map((value) => {
          const clue = category.rows.find((row) => row.value === value);
          if (!clue) return null;
          return {
            id: clue.id,
            question: clue.question,
            value: clue.value,
            round: clue.round,
            dailyDouble: clue.dailyDouble,
            category: category.category,
          };
        }),
      })),
  };
}

export async function getEpisodeBoard(dateStr?: string): Promise<SharedEpisode> {
  let resolvedDate = dateStr;
  if (!resolvedDate || !/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
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
      throw new Error("no eligible episodes");
    }
    const d = rows[0].airDate;
    resolvedDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  const date = new Date(`${resolvedDate}T00:00:00Z`);
  const clues = await prisma.clue.findMany({
    where: { airDate: date },
    include: { category: true },
    orderBy: [{ categoryId: "asc" }, { value: "asc" }],
  });
  if (clues.length === 0) {
    throw new Error("episode not found");
  }

  warmWikiCache(clues);

  const jeopardy = clues.filter((clue) => clue.round === "JEOPARDY");
  const doubleJeopardy = clues.filter(
    (clue) => clue.round === "DOUBLE_JEOPARDY",
  );
  const finalJeopardy = clues.find((clue) => clue.round === "FINAL_JEOPARDY");

  return {
    date: resolvedDate,
    jeopardy: buildRoundBoard(jeopardy),
    doubleJeopardy: buildRoundBoard(doubleJeopardy),
    finalJeopardy: finalJeopardy
      ? {
          id: finalJeopardy.id,
          question: finalJeopardy.question,
          value: finalJeopardy.value,
          round: finalJeopardy.round,
          dailyDouble: finalJeopardy.dailyDouble,
          category: finalJeopardy.category.name,
        }
      : null,
  };
}

export async function getMixedBoard(): Promise<SharedEpisode> {
  const J_VALUES = [200, 400, 600, 800, 1000];
  const DJ_VALUES = [400, 800, 1200, 1600, 2000];

  async function buildRound(
    round: "JEOPARDY" | "DOUBLE_JEOPARDY",
    values: number[],
  ): Promise<SharedRoundBoard> {
    const rows = await prisma.$queryRaw<{ categoryId: number }[]>`
      SELECT "categoryId"
      FROM "Clue"
      WHERE round = ${round}::"Round" AND value = ANY(${values}::int[])
      GROUP BY "categoryId"
      HAVING COUNT(DISTINCT value) = ${values.length}
      ORDER BY RANDOM()
      LIMIT 6
    `;
    const ids = rows.map((row) => row.categoryId);
    if (ids.length === 0) {
      return { values, categories: [] };
    }

    const clues = await prisma.clue.findMany({
      where: {
        categoryId: { in: ids },
        round,
        value: { in: values },
      },
      include: { category: true },
    });
    const byCategory = new Map<
      number,
      {
        name: string;
        cells: Map<number, (typeof clues)[number]>;
      }
    >();
    for (const clue of clues) {
      if (!byCategory.has(clue.categoryId)) {
        byCategory.set(clue.categoryId, {
          name: clue.category.name,
          cells: new Map(),
        });
      }
      const entry = byCategory.get(clue.categoryId)!;
      if (!entry.cells.has(clue.value)) {
        entry.cells.set(clue.value, clue);
      }
    }

    return {
      values,
      categories: ids
        .map((id) => byCategory.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .map((category) => ({
          name: category.name,
          cells: values.map((value) => {
            const clue = category.cells.get(value);
            if (!clue) return null;
            return {
              id: clue.id,
              question: clue.question,
              value: clue.value,
              round: clue.round,
              dailyDouble: clue.dailyDouble,
              category: category.name,
            };
          }),
        })),
    };
  }

  const [jeopardy, doubleJeopardy, finalRows] = await Promise.all([
    buildRound("JEOPARDY", J_VALUES),
    buildRound("DOUBLE_JEOPARDY", DJ_VALUES),
    prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Clue" WHERE round = 'FINAL_JEOPARDY' ORDER BY RANDOM() LIMIT 1
    `,
  ]);

  let finalJeopardy: SharedCell | null = null;
  if (finalRows.length > 0) {
    const final = await prisma.clue.findUnique({
      where: { id: finalRows[0].id },
      include: { category: true },
    });
    if (final) {
      finalJeopardy = {
        id: final.id,
        question: final.question,
        value: final.value,
        round: final.round,
        dailyDouble: final.dailyDouble,
        category: final.category.name,
      };
    }
  }

  function sprinkleDailyDoubles(board: SharedRoundBoard, count: number) {
    let cells: { categoryIdx: number; cellIdx: number }[] = [];
    board.categories.forEach((category, categoryIdx) => {
      category.cells.forEach((cell, cellIdx) => {
        if (cell) {
          cell.dailyDouble = false;
          cells.push({ categoryIdx, cellIdx });
        }
      });
    });
    for (let i = 0; i < count && cells.length > 0; i++) {
      const idx = Math.floor(Math.random() * cells.length);
      const picked = cells[idx];
      const cell = board.categories[picked.categoryIdx].cells[picked.cellIdx];
      if (cell) {
        cell.dailyDouble = true;
      }
      cells = cells.filter((entry) => entry.categoryIdx !== picked.categoryIdx);
    }
  }

  sprinkleDailyDoubles(jeopardy, 1);
  sprinkleDailyDoubles(doubleJeopardy, 2);

  const allClues = [
    ...jeopardy.categories.flatMap((category) => category.cells),
    ...doubleJeopardy.categories.flatMap((category) => category.cells),
    finalJeopardy,
  ].filter((clue): clue is SharedCell => Boolean(clue));
  const fullClues = await prisma.clue.findMany({
    where: { id: { in: allClues.map((clue) => clue.id) } },
    include: { category: true },
  });
  warmWikiCache(fullClues);

  return { jeopardy, doubleJeopardy, finalJeopardy };
}
