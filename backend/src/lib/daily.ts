import crypto from "crypto";
import { prisma } from "./prisma";

export const DAILY_CLUE_COUNT = 30;

const DAILY_SALT = process.env.JWT_SECRET ?? "";

/**
 * Implements the today key function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
export function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Checks the daily date key condition.
 *
 * Parameters:
 * - `value` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 */
export function isDailyDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Implements the date at utc function.
 *
 * Parameters:
 * - `key` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Date`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
export function dateAtUTC(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * Implements the next date at utc function.
 *
 * Parameters:
 * - `key` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Date`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
export function nextDateAtUTC(key: string): Date {
  return new Date(dateAtUTC(key).getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Normalizes daily date input.
 *
 * Parameters:
 * - `value` (`unknown`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 */
export function normalizeDailyDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = value.trim();
  if (!isDailyDateKey(date)) return null;
  return date;
}

/**
 * Implements the date is in future function.
 *
 * Parameters:
 * - `dayKey` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 */
export function dateIsInFuture(dayKey: string): boolean {
  return dateAtUTC(dayKey).getTime() > dateAtUTC(todayKey()).getTime();
}

/**
 * Implements the pick id function.
 *
 * Parameters:
 * - `dayKey` (`string`): Caller-provided value consumed by the function body.
 * - `index` (`number`): Numeric index used to select or order an item in a collection.
 * - `maxId` (`number`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `number`: Numeric value calculated from inputs, state, or persisted data.
 *
 * Data transformations:
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
function pickId(dayKey: string, index: number, maxId: number): number {
  const hash = crypto
    .createHmac("sha256", DAILY_SALT)
    .update(`${dayKey}:${index}`)
    .digest("hex");
  const n = BigInt(`0x${hash.slice(0, 12)}`);
  return Number(n % BigInt(maxId)) + 1;
}

/**
 * Implements the get daily clue ids function.
 *
 * Parameters:
 * - `dayKey` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<number[]>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
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
