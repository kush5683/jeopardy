import { PlayMode } from "@prisma/client";
import { prisma } from "./prisma";
import { judgeWithLLM } from "./llmJudge";
import { getCuratedAliases } from "./curatedAliases";
import { scheduleReviewOnWrong } from "../routes/review";

type ClueRecord = Awaited<ReturnType<typeof prisma.clue.findUnique>>;

type SubmitClueAnswerParams = {
  userId: string;
  clueId: number;
  answer: string;
  responseTimeMs: number;
  mode: PlayMode;
  wager?: number | null;
  buzzerSessionId?: string | null;
};

type AnswerVerdict = {
  correct: boolean;
  canonicalAnswer: string;
  llmVerdict: boolean | null;
};

const NUM_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
  thirty: "30",
  forty: "40",
  fifty: "50",
  sixty: "60",
  seventy: "70",
  eighty: "80",
  ninety: "90",
  hundred: "100",
  thousand: "1000",
  million: "1000000",
  billion: "1000000000",
  twenties: "20s",
  thirties: "30s",
  forties: "40s",
  fifties: "50s",
  sixties: "60s",
  seventies: "70s",
  eighties: "80s",
  nineties: "90s",
};

function normalize(s: string): string {
  const base = s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^(what|who|where|when|why|how)\s+(is|are|was|were)\s+/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/[‘’']/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base
    .split(" ")
    .map((word) => NUM_WORDS[word] ?? word)
    .join(" ");
}

function isInflection(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  const suffixes = ["ing", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (longer === shorter + suffix) return true;
    if (
      (suffix === "ing" || suffix === "ed") &&
      longer === shorter + shorter.slice(-1) + suffix
    ) {
      return true;
    }
    if (
      (suffix === "ing" || suffix === "ed") &&
      shorter.endsWith("e") &&
      longer === shorter.slice(0, -1) + suffix
    ) {
      return true;
    }
    if (
      shorter.endsWith("y") &&
      longer === shorter.slice(0, -1) + "i" + suffix
    ) {
      return true;
    }
  }
  return false;
}

const STOPWORDS = new Set([
  "of",
  "the",
  "a",
  "an",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "by",
  "with",
]);

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function phraseWordsAlign(a: string, b: string): boolean {
  const aWords = a.split(" ").filter(Boolean);
  const bWords = b.split(" ").filter(Boolean);
  if (aWords.length === 0 || bWords.length === 0) return false;
  function wordThreshold(len: number): number {
    if (len <= 4) return 0;
    return Math.max(1, Math.floor(len / 5));
  }
  function has(word: string, candidates: string[]): boolean {
    const threshold = wordThreshold(word.length);
    return candidates.some(
      (candidate) =>
        editDistance(word, candidate) <= threshold ||
        isInflection(word, candidate),
    );
  }
  const aContent = aWords.filter((word) => !STOPWORDS.has(word));
  const bContent = bWords.filter((word) => !STOPWORDS.has(word));
  if (aContent.length === 0 || bContent.length === 0) return false;
  return (
    bContent.every((word) => has(word, aWords)) &&
    aContent.every((word) => has(word, bWords))
  );
}

function containsAsPhrase(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

function fuzzyThreshold(len: number): number {
  if (len <= 3) return 0;
  return Math.max(1, Math.floor(len / 5));
}

function importantWords(s: string): string[] {
  return s
    .split(" ")
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}

const MULTI_OPTION_SKIP = new Set([
  "and",
  "or",
  "of",
  "is",
  "are",
  "was",
  "were",
  "&",
]);

function tryMultiOption(
  submittedRaw: string,
  canonicalRaw: string,
): boolean | null {
  const match = canonicalRaw.match(/^\s*\(?\s*(\d+)\s+of\)?\s+(.*)$/i);
  if (!match) return null;
  const count = parseInt(match[1], 10);
  if (!Number.isFinite(count) || count < 1) return null;
  const rest = match[2];
  const orParts = rest.split(/\s+or\s+/i);
  let optionsRaw: string[];
  if (orParts.length >= 2) {
    const last = orParts[orParts.length - 1];
    const head = orParts.slice(0, -1).join(" or ");
    optionsRaw = [
      ...head
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      last.trim(),
    ];
  } else {
    optionsRaw = rest
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (optionsRaw.length < count) return null;
  const options = optionsRaw
    .map((option) => normalize(option))
    .filter((option) => option.length > 0)
    .map((option) => ({ text: option, words: option.split(" ") }));
  const userTokens = normalize(submittedRaw)
    .split(" ")
    .filter(
      (token) =>
        token && !MULTI_OPTION_SKIP.has(token) && !/^\d+$/.test(token),
    );
  if (userTokens.length === 0) return false;
  const sorted = [...options].sort((a, b) => b.words.length - a.words.length);
  const used = new Set<number>();
  let matched = 0;
  for (const option of sorted) {
    const len = option.words.length;
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
      if (editDistance(span, option.text) <= fuzzyThreshold(option.text.length)) {
        for (let k = 0; k < len; k++) used.add(i + k);
        matched++;
        break;
      }
    }
  }
  const unmatched = userTokens.length - used.size;
  return matched >= count && unmatched === 0;
}

function tryAmpersandList(
  submittedRaw: string,
  canonicalRaw: string,
): boolean | null {
  if (!/\s+&\s+/.test(canonicalRaw)) return null;
  const parts = canonicalRaw
    .split(/\s+&\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const normalizedParts = parts.map((part) => normalize(part));
  if (normalizedParts.every((part) => part.length === 1)) {
    const letters = submittedRaw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (letters.length !== normalizedParts.length) return false;
    return [...letters].sort().join("") === [...normalizedParts].sort().join("");
  }
  if (parts.some((part) => normalize(part).length < 3)) return null;
  const options = parts
    .map((part) => normalize(part))
    .map((option) => ({ text: option, words: option.split(" ") }));
  const userTokens = normalize(submittedRaw)
    .split(" ")
    .filter(
      (token) =>
        token && !MULTI_OPTION_SKIP.has(token) && !/^\d+$/.test(token),
    );
  if (userTokens.length === 0) return false;
  const sorted = [...options].sort((a, b) => b.words.length - a.words.length);
  const used = new Set<number>();
  let matched = 0;
  for (const option of sorted) {
    const len = option.words.length;
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
      if (editDistance(span, option.text) <= fuzzyThreshold(option.text.length)) {
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
  let match: RegExpExecArray | null;
  while ((match = re.exec(canonical)) !== null) {
    const inner = match[1].trim();
    if (inner) out.push(inner);
  }
  return out;
}

const DECADE_WORD_BY_TENS: Record<string, string> = {
  "2": "twenties",
  "3": "thirties",
  "4": "forties",
  "5": "fifties",
  "6": "sixties",
  "7": "seventies",
  "8": "eighties",
  "9": "nineties",
};

function decadeAliasesOf(s: string): string[] {
  const re = /\b[12]\d([2-9])0'?s\b/i;
  if (!re.test(s)) return [];
  const short = s.replace(
    /\b[12]\d([2-9])0'?s\b/gi,
    (_, digit: string) => `${digit}0s`,
  );
  const word = s.replace(
    /\b[12]\d([2-9])0'?s\b/gi,
    (_, digit: string) => DECADE_WORD_BY_TENS[digit],
  );
  return [short, word];
}

export function isCorrect(
  submitted: string,
  canonical: string,
  aliases: string[] = [],
): boolean {
  if (matchAgainst(submitted, canonical)) return true;
  for (const parenthetical of extractParentheticals(canonical)) {
    if (matchAgainst(submitted, parenthetical)) return true;
  }
  const submittedHasYear = /\b[12]\d[2-9]0'?s\b/i.test(submitted);
  const canonicalHasYear = /\b[12]\d[2-9]0'?s\b/i.test(canonical);
  if (!submittedHasYear) {
    for (const alias of decadeAliasesOf(canonical)) {
      if (matchAgainst(submitted, alias)) return true;
    }
  }
  if (!canonicalHasYear) {
    for (const alias of decadeAliasesOf(submitted)) {
      if (matchAgainst(alias, canonical)) return true;
    }
  }
  for (const alias of getCuratedAliases(canonical)) {
    if (matchAgainst(submitted, alias)) return true;
  }
  for (const alias of aliases) {
    if (matchAgainst(submitted, alias)) return true;
  }
  return false;
}

function matchAgainst(submitted: string, canonical: string): boolean {
  const multi = tryMultiOption(submitted, canonical);
  if (multi !== null) return multi;
  const amp = tryAmpersandList(submitted, canonical);
  if (amp !== null) return amp;

  const a = normalize(submitted);
  const b = normalize(canonical);
  if (!a) return false;
  if (a === b) return true;

  const yearDecadeRe = /^[12]\d[2-9]0s$/;
  if (yearDecadeRe.test(a) && yearDecadeRe.test(b)) return false;

  const canonicalTokens = b.split(" ").filter((word) => word.length >= 1);
  if (
    canonicalTokens.length >= 3 ||
    (canonicalTokens.length >= 2 &&
      canonicalTokens.every((word) => word.length === 1))
  ) {
    const initialism = canonicalTokens.map((word) => word[0]).join("");
    if (a.replace(/\s+/g, "") === initialism) return true;
  }

  const aHasSpace = a.includes(" ");
  const bHasSpace = b.includes(" ");
  if (!aHasSpace && !bHasSpace) {
    if (editDistance(a, b) <= fuzzyThreshold(b.length)) return true;
    if (isInflection(a, b)) return true;
  } else if (phraseWordsAlign(a, b)) {
    return true;
  }

  if (aHasSpace !== bHasSpace) {
    const single = aHasSpace ? b : a;
    const joined = (aHasSpace ? a : b).replace(/ /g, "");
    if (editDistance(joined, single) <= fuzzyThreshold(single.length)) return true;
  }

  const bImportantCount = importantWords(b).length;
  if (a.length >= 4 && bImportantCount < 4 && containsAsPhrase(b, a)) return true;
  if (b.length >= 4 && containsAsPhrase(a, b)) return true;

  if (b.length <= 3) {
    for (const submittedWord of a.split(" ")) {
      if (submittedWord === b) return true;
    }
  }

  const aWords = a.split(" ").filter((word) => word.length >= 3);
  const bWords = importantWords(b);
  const aTokens = a.split(" ").filter(Boolean);
  const bTokensAll = b.split(" ").filter(Boolean);
  const userHasUnmatchedExtra = aTokens
    .filter((word) => !STOPWORDS.has(word))
    .some((word) => {
      const threshold =
        word.length <= 4 ? 0 : Math.max(1, Math.floor(word.length / 5));
      return !bTokensAll.some(
        (candidate) =>
          editDistance(word, candidate) <= threshold ||
          isInflection(word, candidate),
      );
    });
  if (!userHasUnmatchedExtra && bWords.length > 0 && bWords.length < 4) {
    const maxLen = Math.max(...bWords.map((word) => word.length));
    const keywords = bWords.filter((word) => word.length === maxLen);
    for (const canonicalWord of keywords) {
      const threshold = fuzzyThreshold(canonicalWord.length);
      for (const submittedWord of aWords) {
        if (
          editDistance(submittedWord, canonicalWord) <= threshold ||
          isInflection(submittedWord, canonicalWord)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

export async function checkClueAnswer(
  clue: NonNullable<ClueRecord>,
  answer: string,
): Promise<AnswerVerdict> {
  let llmVerdict: boolean | null = null;
  let correct = isCorrect(answer, clue.answer, clue.wikiAliases);
  if (!correct) {
    llmVerdict = await judgeWithLLM(
      clue.question,
      clue.answer,
      clue.wikiAliases,
      answer,
    );
    correct = llmVerdict;
  }
  return {
    correct,
    canonicalAnswer: clue.answer,
    llmVerdict,
  };
}

export function scoreDeltaForClue(
  correct: boolean,
  clueValue: number,
  wager?: number | null,
): number {
  const amount = wager ?? clueValue;
  return correct ? amount : -amount;
}

export async function submitClueAnswer({
  userId,
  clueId,
  answer,
  responseTimeMs,
  mode,
  wager,
  buzzerSessionId,
}: SubmitClueAnswerParams) {
  const clue = await prisma.clue.findUnique({ where: { id: clueId } });
  if (!clue) {
    const err = new Error("clue not found");
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  const wagerAllowed =
    clue.dailyDouble || mode === "FINAL" || mode === "BOARD";
  if (wager != null && !wagerAllowed) {
    const err = new Error("wager not allowed for this clue");
    (err as Error & { status?: number }).status = 400;
    throw err;
  }

  const verdict = await checkClueAnswer(clue, answer);
  const sessionId = mode === "BUZZER" ? buzzerSessionId ?? null : null;
  const response = await prisma.clueResponse.create({
    data: {
      userId,
      clueId,
      correct: verdict.correct,
      responseTimeMs,
      mode,
      wager: wager ?? null,
      buzzerSessionId: sessionId,
    },
  });
  if (!verdict.correct) {
    await scheduleReviewOnWrong(userId, clueId);
  }
  return {
    clue,
    response,
    correct: verdict.correct,
    canonicalAnswer: verdict.canonicalAnswer,
    llmVerdict: verdict.llmVerdict,
    valueDelta: scoreDeltaForClue(verdict.correct, clue.value, wager),
  };
}
