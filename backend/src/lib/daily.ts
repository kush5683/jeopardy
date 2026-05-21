import crypto from "crypto";
import { prisma } from "./prisma";

export const DAILY_CLUE_COUNT = 30;

const DAILY_SALT = process.env.JWT_SECRET ?? "";

export function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function isDailyDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function dateAtUTC(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export function nextDateAtUTC(key: string): Date {
  return new Date(dateAtUTC(key).getTime() + 24 * 60 * 60 * 1000);
}

export function normalizeDailyDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.trim();
  if (!isDailyDateKey(date)) return null;
  return date;
}

export function dateIsInFuture(dayKey: string): boolean {
  return dateAtUTC(dayKey).getTime() > dateAtUTC(todayKey()).getTime();
}

function pickId(dayKey: string, index: number, maxId: number): number {
  const hash = crypto
    .createHmac("sha256", DAILY_SALT)
    .update(`${dayKey}:${index}`)
    .digest("hex");
  const n = BigInt(`0x${hash.slice(0, 12)}`);
  return Number(n % BigInt(maxId)) + 1;
}

export async function getDailyClueIds(dayKey: string): Promise<number[]> {
  const result = await prisma.clue.aggregate({ _max: { id: true } });
  const maxId = result._max.id ?? 0;
  if (maxId === 0) return [];

  const candidates: number[] = [];
  for (let i = 0; i < DAILY_CLUE_COUNT * 3; i++) {
    candidates.push(pickId(dayKey, i, maxId));
  }
  const found = await prisma.clue.findMany({
    where: { id: { in: candidates } },
    include: { category: true },
  });
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
