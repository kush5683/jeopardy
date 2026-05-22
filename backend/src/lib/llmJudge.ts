// LLM fallback judge for answers the deterministic matcher in clues.ts rejects.
// Calls a local Ollama instance. Conservative by design: only returns true on an
// unambiguous "YES" from the model. Any error, timeout, or fuzzy response = false,
// so the deterministic verdict stands and the game never blocks on a missing model.
//
// Persistence: accepted (YES) verdicts are written to AcceptedLLMVerdict so a
// repeat (canonical, submitted) pair short-circuits the model on future calls.
// Rejected verdicts are NOT persisted — we want to re-ask if prompts/weights improve.

import { prisma } from "./prisma";

const ENABLED = process.env.LLM_JUDGE_DISABLED !== "1";
const MODEL = process.env.LLM_JUDGE_MODEL ?? "qwen2.5:7b";
const HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const TIMEOUT_MS = Number(process.env.LLM_JUDGE_TIMEOUT_MS ?? 4000);
const MEM_CACHE_MAX = 1000;

// In-memory cache fronts the DB so repeat lookups in the same process don't hit
// Postgres. Stores true verdicts only (mirrors the DB).
const memCache = new Map<string, true>();

// Serialize LLM invocations across the whole process so we never have more than
// one inference in flight at a time. Without this, concurrent users can pin
// multiple KV-cache slots inside Ollama and degrade per-request latency.
// Only the fetch() is locked — DB/memory cache lookups still run in parallel.
let llmQueue: Promise<void> = Promise.resolve();

/**
 * Implements the with llmlock function.
 *
 * Parameters:
 * - `fn` (`() => Promise<T>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<T>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
async function withLLMLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = llmQueue;
  let release!: () => void;
  llmQueue = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

/**
 * Implements the norm key function.
 *
 * Parameters:
 * - `s` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 */
function normKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Implements the cache key function.
 *
 * Parameters:
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 * - `submitted` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function cacheKey(canonical: string, submitted: string): string {
  return `${normKey(canonical)}::${normKey(submitted)}`;
}

/**
 * Implements the set mem cache function.
 *
 * Parameters:
 * - `key` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function setMemCache(key: string): void {
  if (memCache.size >= MEM_CACHE_MAX) {
    const first = memCache.keys().next().value;
    if (first !== undefined) memCache.delete(first);
  }
  memCache.set(key, true);
}

/**
 * Builds prompt data.
 *
 * Parameters:
 * - `clueText` (`string`): Clue data read from API or database rows and reshaped for gameplay.
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 * - `aliases` (`string[]`): Caller-provided value consumed by the function body.
 * - `submitted` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 */
function buildPrompt(
  clueText: string,
  canonical: string,
  aliases: string[],
  submitted: string,
): string {
  const aliasLine =
    aliases.length > 0 ? `\nAlso acceptable: ${aliases.slice(0, 8).join(", ")}` : "";
  // Few-shot with both positive and negative examples. The negatives (Charlotte
  // vs Greensboro, Louis X vs Louis XIV) are the load-bearing part — without
  // them, models tend to accept anything plausibly-related.
  return `You are judging a Jeopardy game. Decide whether the contestant named the SAME entity as the canonical answer. If the canonical appears to contain an obvious typo but the clue and contestant answer clearly identify the same intended answer, say YES.

Examples:
Clue: This American author wrote Tom Sawyer.
Canonical: Mark Twain | Contestant: Samuel Clemens | Verdict: YES (real name of Mark Twain)

Clue: This pirate terrorized the Carolinas.
Canonical: Blackbeard | Contestant: black beard | Verdict: YES (just spaced spelling)

Clue: This NC city had the 1960 lunch counter sit-in.
Canonical: Greensboro | Contestant: Greensborough | Verdict: YES (spelling variant, same NC city per clue)

Clue: This NC city had the 1960 lunch counter sit-in.
Canonical: Greensboro | Contestant: Charlotte | Verdict: NO (different NC city)

Clue: This French king built Versailles.
Canonical: Louis XIV | Contestant: Louis X | Verdict: NO (different French king, X ≠ XIV)

Clue: This longest US river empties into the Gulf.
Canonical: Mississippi | Contestant: Mississipi | Verdict: YES (one-letter typo)

Clue: Term for a hot spring that spews intermittent plumes of water & steam.
Canonical: a geysor | Contestant: guyser | Verdict: YES (the canonical appears misspelled, but both clearly mean geyser)

Now judge this one. Reply with ONLY one word: YES or NO.
Clue: ${clueText}
Canonical: ${canonical}${aliasLine} | Contestant: ${submitted} | Verdict:`;
}

/**
 * Implements the judge with llm function.
 *
 * Parameters:
 * - `clueText` (`string`): Clue data read from API or database rows and reshaped for gameplay.
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 * - `aliases` (`string[]`): Caller-provided value consumed by the function body.
 * - `submitted` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<boolean>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export async function judgeWithLLM(
  clueText: string,
  canonical: string,
  aliases: string[],
  submitted: string,
): Promise<boolean> {
  if (!ENABLED) return false;
  if (!submitted.trim()) return false;

  const key = cacheKey(canonical, submitted);
  if (memCache.has(key)) return true;

  // DB lookup: a prior YES verdict for this pair short-circuits the model.
  try {
    const hit = await prisma.acceptedLLMVerdict.findUnique({
      where: {
        canonical_submitted: {
          canonical: normKey(canonical),
          submitted: normKey(submitted),
        },
      },
    });
    if (hit) {
      setMemCache(key);
      return true;
    }
  } catch {
    // Table missing / DB unavailable — fall through to LLM call.
  }

  const controller = new AbortController();
  /**
   * Runs the delayed setTimeout timer callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Re-check the memory cache *inside* the lock: while we were queued, an
    // earlier request may have just persisted a YES for the same pair.
    const result = await withLLMLock(async () => {
      if (memCache.has(key)) return { verdict: true, fromCache: true } as const;
      const res = await fetch(`${HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt: buildPrompt(clueText, canonical, aliases, submitted),
          stream: false,
          options: { temperature: 0, num_predict: 4 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return { verdict: false, fromCache: false } as const;
      const data = (await res.json()) as { response?: string };
      return {
        verdict: /^\s*yes\b/i.test(data.response ?? ""),
        fromCache: false,
      } as const;
    });
    const verdict = result.verdict;
    if (verdict && !result.fromCache) {
      setMemCache(key);
      // Best-effort write; race-safe via the unique index. Don't await — we
      // already have the answer and don't need to block the response.
      void prisma.acceptedLLMVerdict
        .create({
          data: { canonical: normKey(canonical), submitted: normKey(submitted) },
        })
        .catch(() => {
          // Unique violation (already persisted by a concurrent request) or DB error.
          // Either way the in-memory cache will absorb future hits; safe to ignore.
        });
    }
    return verdict;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Given multiple Wikipedia search candidates, picks the index of the title most
// relevant to the clue + canonical answer. Used by wikipedia.ts to disambiguate
// when opensearch returns 2+ candidates ("Pump" → band album vs. mechanical vs. shoe).
// Returns null on error or if the LLM can't choose, in which case the caller
// should fall back to its existing first-match behavior. Uses the same lock as
// judgeWithLLM so wiki picks don't run in parallel with answer judging.
/**
 * Implements the pick wiki title with llm function.
 *
 * Parameters:
 * - `clueText` (`string`): Clue data read from API or database rows and reshaped for gameplay.
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 * - `titles` (`string[]`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<number | null>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export async function pickWikiTitleWithLLM(
  clueText: string,
  canonical: string,
  titles: string[],
): Promise<number | null> {
  if (!ENABLED) return null;
  if (titles.length < 2) return null;

  const numbered = titles.map((t, i) => `${i}. ${t}`).join("\n");
  const prompt = `You are helping pick the right Wikipedia article for a Jeopardy clue. Given the clue and canonical answer, choose which candidate title is most relevant.

Clue: ${clueText}
Canonical answer: ${canonical}

Candidates:
${numbered}

Reply with ONLY the number (0-${titles.length - 1}) of the best candidate. No words, no punctuation.`;

  const controller = new AbortController();
  /**
   * Runs the delayed setTimeout timer callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await withLLMLock(async () => {
      const res = await fetch(`${HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          stream: false,
          options: { temperature: 0, num_predict: 4 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      const m = (data.response ?? "").match(/\d+/);
      if (!m) return null;
      const idx = parseInt(m[0], 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= titles.length) return null;
      return idx;
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Generates a short post-hoc hint explaining how the clue's wordplay or structure
// points to the answer. Best-effort — returns null on any failure. Uses the shared
// LLM mutex so it can't compete with answer judgments for inference slots.
// Hints get a longer timeout (10s) than judgments since they're computed off the
// critical path and the user is reading the clue while we generate.
/**
 * Implements the generate hint with llm function.
 *
 * Parameters:
 * - `clueText` (`string`): Clue data read from API or database rows and reshaped for gameplay.
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<string | null>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export async function generateHintWithLLM(
  clueText: string,
  canonical: string,
): Promise<string | null> {
  if (!ENABLED) return null;
  const prompt = `You explain Jeopardy! clues that contain wordplay, puns, or hidden structure. Many clues do NOT have wordplay — they're just descriptions of the answer. For those, do not invent a hint.

Clue: ${clueText}
Answer: ${canonical}

Rules:
- If the clue is a straightforward factual description with no wordplay, pun, or hidden structure → reply with exactly one word: NONE
- Do NOT call something wordplay just because a word in the clue resembles a word in the answer by coincidence — there must be deliberate, recognizable wordplay.
- Do NOT restate the answer's definition. "Cilia are hair-like structures" is the definition, not a hint.
- If there IS real wordplay (e.g. category combines multiple meanings, the clue contains a pun, a word hints at the answer, "colorful" pirate → Blackbeard, "Attorney General + General Tso's + chicken scratch" combo) → explain it in ONE short sentence. No preamble.

Examples:
Clue: "Nation's top lawyer & a poultry dish named for a mighty Chinese military man combine for illegible handwriting" / Answer: Attorney General Tso's chicken scratch → "Combines 'Attorney General' (top lawyer) + 'General Tso's chicken' (the dish) + 'chicken scratch' (bad handwriting)."
Clue: "This colorful pirate was killed in 1718" / Answer: Blackbeard → "'Colorful' hints at the color 'black' in the name."
Clue: "These small hair-like structures help cells move" / Answer: Cilia → NONE
Clue: "This pope died in 2005" / Answer: John Paul II → NONE

Your response:`;

  const controller = new AbortController();
  /**
   * Runs the delayed setTimeout timer callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await withLLMLock(async () => {
      const res = await fetch(`${HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          prompt,
          stream: false,
          options: { temperature: 0.3, num_predict: 120 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      const text = (data.response ?? "").trim();
      if (text.length === 0) return null;
      // Suppress hints for clues with no real wordplay — model is instructed
      // to reply NONE in that case. Also defensively catch near-misses where
      // the model returns "None" or "NONE." or similar.
      if (/^none\b/i.test(text)) return null;
      return text;
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// In-flight hint generations keyed by clueId. Lets a second /prepare call for
// the same clue join the existing job instead of firing another one, and lets
// the /hint GET endpoint distinguish "not started" from "currently generating".
const inFlightHints = new Map<number, Promise<string | null>>();

// Kicks off hint generation for a clue if it's not already cached or in flight.
// Idempotent and fire-and-forget — returns the in-flight promise so callers can
// await if they want, but most callers should NOT await (the whole point is to
// run in the background while the user is reading the clue).
/**
 * Implements the prepare hint function.
 *
 * Parameters:
 * - `clueId` (`number`): Identifier value used to look up, compare, or persist related records.
 * - `clueText` (`string`): Clue data read from API or database rows and reshaped for gameplay.
 * - `canonical` (`string`): Caller-provided value consumed by the function body.
 * - `onComplete` (`(hint: string | null) => Promise<void>`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Promise<string | null>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function prepareHint(
  clueId: number,
  clueText: string,
  canonical: string,
  onComplete: (hint: string | null) => Promise<void>,
): Promise<string | null> {
  const existing = inFlightHints.get(clueId);
  if (existing) return existing;
  const job = (async () => {
    try {
      const hint = await generateHintWithLLM(clueText, canonical);
      await onComplete(hint);
      return hint;
    } catch {
      return null;
    } finally {
      inFlightHints.delete(clueId);
    }
  })();
  inFlightHints.set(clueId, job);
  return job;
}

/**
 * Checks the hint in flight condition.
 *
 * Parameters:
 * - `clueId` (`number`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function isHintInFlight(clueId: number): boolean {
  return inFlightHints.has(clueId);
}

// Fires a throwaway judge call to force Ollama to load the model into memory.
// Without this, the first real submission pays a ~15s cold-start hit.
// Best-effort: errors (Ollama not running, etc.) are swallowed.
/**
 * Implements the prewarm llmjudge function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Fetches remote/API data and projects the response into local state or return values.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export async function prewarmLLMJudge(): Promise<void> {
  if (!ENABLED) return;
  const controller = new AbortController();
  /**
   * Runs the delayed setTimeout timer callback.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    await fetch(`${HOST}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt: "Reply with YES.",
        stream: false,
        options: { temperature: 0, num_predict: 4 },
      }),
      signal: controller.signal,
    });
  } catch {
    // ignore
  } finally {
    clearTimeout(timer);
  }
}
