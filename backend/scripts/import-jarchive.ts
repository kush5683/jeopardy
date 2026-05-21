import { PrismaClient, Round } from "@prisma/client";
import * as fs from "fs";

const prisma = new PrismaClient();

// TSV round codes from jwolle1/jeopardy_clue_dataset
const ROUND_MAP: Record<string, Round> = {
  "1": Round.JEOPARDY,
  "2": Round.DOUBLE_JEOPARDY,
  "3": Round.FINAL_JEOPARDY,
};

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\\"/g, '"')
    // jarchive TSV escapes embedded apostrophes as \' — unescape so categories
    // like "GONE FISHIN'" and "'60s SONGS" don't display a stray backslash.
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeMedia(rawAnswer: string): boolean {
  // The jwolle1 dataset embeds <a href=...> for video/audio media clues.
  return /<a\s+href=/i.test(rawAnswer) || /\(audio\s+clue\s*\)/i.test(rawAnswer);
}

async function main() {
  const path = process.argv[2] || "/data/combined.tsv";
  if (!fs.existsSync(path)) {
    console.error(`file not found: ${path}`);
    process.exit(1);
  }

  const existing = await prisma.clue.count();
  if (existing > 200) {
    console.error(
      `Clue table has ${existing} rows — aborting (looks like a re-import). ` +
      `Delete clues first or pass --force.`,
    );
    if (!process.argv.includes("--force")) process.exit(1);
  }

  console.log(`reading ${path}...`);
  const file = fs.readFileSync(path, "utf-8");
  const lines = file.split("\n");
  console.log(`${lines.length} lines`);

  const categorySet = new Set<string>();
  const rows: {
    round: Round;
    value: number;
    dailyDouble: boolean;
    category: string;
    question: string;
    answer: string;
    airDate: Date | null;
  }[] = [];

  let skippedMedia = 0;
  let skippedEmpty = 0;
  let skippedRound = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 9) {
      skippedEmpty++;
      continue;
    }
    const [roundStr, valStr, ddStr, cat, , rawAns, rawQ, dateStr] = parts;

    const round = ROUND_MAP[roundStr];
    if (!round) {
      skippedRound++;
      continue;
    }
    if (looksLikeMedia(rawAns)) {
      skippedMedia++;
      continue;
    }
    // Map: their "answer" (clue text) → our "question"; their "question" (response) → our "answer".
    const question = stripHtml(rawAns);
    const answer = stripHtml(rawQ);
    if (!question || !answer) {
      skippedEmpty++;
      continue;
    }
    // The TSV escapes embedded quotes as \" and apostrophes as \' — unescape so
    // categories like "GONE FISHIN'" and "'60s SONGS" render cleanly.
    const category = cat.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
    if (!category) {
      skippedEmpty++;
      continue;
    }
    categorySet.add(category);

    let airDate: Date | null = null;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      airDate = new Date(`${dateStr}T00:00:00Z`);
    }

    rows.push({
      round,
      value: parseInt(valStr, 10) || 0,
      dailyDouble: (parseInt(ddStr, 10) || 0) > 0,
      category,
      question,
      answer,
      airDate,
    });
  }

  console.log(`parsed ${rows.length} rows`);
  console.log(`skipped: ${skippedMedia} media, ${skippedEmpty} empty/malformed, ${skippedRound} unknown round`);
  console.log(`unique categories: ${categorySet.size}`);

  console.log("upserting categories...");
  await prisma.category.createMany({
    data: Array.from(categorySet).map((name) => ({ name })),
    skipDuplicates: true,
  });
  const cats = await prisma.category.findMany();
  const catMap = new Map(cats.map((c) => [c.name, c.id]));
  console.log(`${cats.length} categories in DB`);

  console.log("inserting clues in batches of 5000...");
  const BATCH = 5000;
  const start = Date.now();
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await prisma.clue.createMany({
      data: batch.map((r) => ({
        categoryId: catMap.get(r.category)!,
        round: r.round,
        value: r.value,
        question: r.question,
        answer: r.answer,
        airDate: r.airDate,
        dailyDouble: r.dailyDouble,
      })),
    });
    const done = Math.min(i + BATCH, rows.length);
    if (done % 50000 < BATCH || done === rows.length) {
      const rate = Math.round(done / ((Date.now() - start) / 1000));
      console.log(`  ${done}/${rows.length} (${rate}/s)`);
    }
  }

  const total = await prisma.clue.count();
  console.log(`done. total clues in DB: ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
