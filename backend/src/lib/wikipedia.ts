import { pickWikiTitleWithLLM } from "./llmJudge";

const UA = "jeopardy.kushshah.net/1.0 (kush@kushshah.net)";

export type WikiData = {
  title: string;
  extract: string;
  url: string;
  thumb: string | null;
  aliases: string[];
};

export type WikiResult = {
  // ok=true means we got a definitive answer from Wikipedia (data OR explicit "nothing found").
  // ok=false means transient error — caller should NOT cache.
  ok: boolean;
  // transient=true means we got a candidate but our relevance gate rejected it.
  // Future improvements to the gate could let us identify a real match, so the
  // caller should NOT persist this miss to the DB. Only meaningful when data is null.
  transient?: boolean;
  data: WikiData | null;
};

const headers = { "User-Agent": UA, Accept: "application/json" };

async function fetchRedirects(title: string): Promise<string[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=redirects&titles=${encodeURIComponent(title)}&rdlimit=500&format=json&formatversion=2`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      query?: { pages?: { redirects?: { title: string }[] }[] };
    };
    const redirects = data?.query?.pages?.[0]?.redirects ?? [];
    return redirects.map((r) => r.title).filter(Boolean);
  } catch {
    return [];
  }
}

// Wikidata aliases — structured, human-curated alternate names for an entity.
// Covers abbreviations like "TB" that Wikipedia redirects miss (because "TB"
// itself is a disambiguation page on Wikipedia, not a redirect to Tuberculosis).
async function fetchWikidataAliases(qid: string): Promise<string[]> {
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(qid)}&props=aliases|labels&languages=en&format=json`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      entities?: Record<string, {
        aliases?: { en?: { value: string }[] };
        labels?: { en?: { value: string } };
      }>;
    };
    const entity = data?.entities?.[qid];
    const aliasList = entity?.aliases?.en ?? [];
    const aliases = aliasList.map((a) => a.value).filter(Boolean);
    const label = entity?.labels?.en?.value;
    return label ? [label, ...aliases] : aliases;
  } catch {
    return [];
  }
}

// Wikipedia redirects include sub-topic pages and descriptive titles that refer
// to a *related* concept, not the entity itself ("John F. Kennedy and civil rights",
// "Early years of John F. Kennedy", "35th President of the United States").
// These create false positives in matching. Filter them out.
const SUBTOPIC_PATTERNS = [
  /\band\b/i,
  /\bin\b/i,
  /\bduring\b/i,
  /\bbefore\b/i,
  /\bafter\b/i,
  /\bearly\b/i,
  /\blate\b/i,
  /\bera\b/i,
  /\bfamily\b/i,
  /\blist of\b/i,
  /\bdisambiguation\b/i,
];

function filterAliases(candidates: string[], canonicalForLen: string): string[] {
  const seen = new Set<string>();
  const canonWordCount = canonicalForLen.trim().split(/\s+/).length;
  const maxWords = canonWordCount + 2;
  const result: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    const stripped = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
    // Keep short curated abbreviations (TB, AC, AD, BC, GDP) — Wikipedia redirects
    // are intentional, and our fuzzy threshold requires exact match for ≤3 chars.
    if (stripped.length < 2) continue;
    const wc = stripped.split(/\s+/).length;
    if (wc > maxWords) continue;
    if (SUBTOPIC_PATTERNS.some((re) => re.test(stripped))) continue;
    const norm = stripped.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(stripped);
  }
  return result.slice(0, 50);
}

// Heuristic: canonicals like "1, 2, 4 & 8", "42", "5/8 inch", "pi r squared"
// aren't real entities, and Wikipedia search returns garbage for them (asteroids,
// random pages). Skip the wiki fetch for these.
function looksLikeEntity(s: string): boolean {
  const stripped = s.replace(/[^a-zA-Z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return false;
  const words = stripped.split(" ").filter((w) => w.length >= 3);
  // Need at least one real word of 3+ letters, AND letters > digits in original.
  if (words.length === 0) return false;
  const letterCount = (s.match(/[a-zA-Z]/g) || []).length;
  const digitCount = (s.match(/\d/g) || []).length;
  return letterCount > digitCount;
}

// Skip generic / wordplay categories that would derail the search rather than help.
const NOISY_CATEGORY_WORDS = new Set([
  "talk", "facts", "stuff", "trivia", "potpourri", "before", "after",
  "wordplay", "words", "the", "and", "or", "of", "in", "on", "at", "&",
]);

const RELEVANCE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "is", "are", "was", "were", "be", "in",
  "on", "at", "to", "for", "by", "with", "from", "as", "this", "that",
]);

function isLeadRelevant(canonical: string, extract: string): boolean {
  // Take roughly the first sentence (or first 240 chars if no sentence break).
  const lead = (extract.split(/\.\s+/)[0] || extract.slice(0, 240)).toLowerCase();
  const canonicalWords = canonical
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !RELEVANCE_STOPWORDS.has(w));
  // If the canonical has no "important" words (e.g. it's "TB" or "1492"),
  // skip the check rather than risk a false negative.
  if (canonicalWords.length === 0) return true;
  return canonicalWords.some((w) => lead.includes(w));
}

function categoryHint(category: string | undefined): string {
  if (!category) return "";
  return category
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !NOISY_CATEGORY_WORDS.has(w))
    .join(" ");
}

export async function fetchWikipedia(
  rawQuery: string,
  category?: string,
  clueText?: string,
): Promise<WikiResult> {
  const query = rawQuery.replace(/^(the|a|an)\s+/i, "").trim();
  if (!query) return { ok: true, data: null };
  if (!looksLikeEntity(query)) return { ok: true, data: null };

  // Combine answer + category hint so an ambiguous common noun like "neck"
  // resolves to the right article ("Neck (music)" instead of "Neck" anatomy).
  // Wikipedia ranks proper-noun matches above keyword matches, so adding
  // context is safe for unambiguous answers like "John F. Kennedy".
  const hint = categoryHint(category);
  const searchQuery = hint ? `${query} ${hint}` : query;

  try {
    // Step 1: opensearch. Try with the category hint first; fall back to plain
    // answer if the contextual search returns nothing (Wikipedia is strict about
    // multi-keyword matching — "supermax jailhouse" returns no results even
    // though "supermax" alone lands on "Supermax prison").
    async function runOpensearch(q: string): Promise<{ titles: string[]; urls: string[] } | null> {
      const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=3&format=json`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (!r.ok) {
        if (r.status >= 500) return null;
        return { titles: [], urls: [] };
      }
      const data = (await r.json()) as [string, string[], string[], string[]];
      return { titles: data?.[1] ?? [], urls: data?.[3] ?? [] };
    }

    let res = await runOpensearch(searchQuery);
    if (res === null) return { ok: false, data: null };
    if (res.titles.length === 0 && searchQuery !== query) {
      res = await runOpensearch(query);
      if (res === null) return { ok: false, data: null };
    }
    let titles = res.titles;
    let urls = res.urls;
    if (titles.length === 0) return { ok: true, data: null };

    // LLM-assisted candidate ranking: when opensearch returns multiple results,
    // the clue text disambiguates (e.g. "Pump" → band album vs. mechanical vs. shoe).
    // Move the LLM's pick to the front; if the LLM is down or can't decide,
    // titles stay in their original opensearch order. Skipped when no clue text
    // is supplied (background warmer can opt in by passing it).
    if (titles.length >= 2 && clueText) {
      const idx = await pickWikiTitleWithLLM(clueText, rawQuery, titles);
      if (idx !== null && idx > 0) {
        titles = [titles[idx], ...titles.filter((_, i) => i !== idx)];
        urls = [urls[idx], ...urls.filter((_, i) => i !== idx)];
      }
    }

    // Step 2: try each candidate's summary until we find a non-disambig page.
    type Summary = {
      type?: string;
      title?: string;
      extract?: string;
      wikibase_item?: string;
      content_urls?: { desktop?: { page?: string } };
      thumbnail?: { source?: string };
    };
    let summary: Summary | null = null;
    let searchTitle = "";
    let fallbackUrl = "";
    for (let i = 0; i < titles.length; i++) {
      const t = titles[i];
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`;
      const sRes = await fetch(summaryUrl, { headers, signal: AbortSignal.timeout(5000) });
      if (!sRes.ok) {
        if (sRes.status >= 500) return { ok: false, data: null };
        continue;
      }
      const candidate = (await sRes.json()) as Summary;
      if (candidate?.type === "disambiguation" || !candidate?.extract) continue;
      summary = candidate;
      searchTitle = t;
      fallbackUrl = urls[i] ?? "";
      break;
    }
    if (!summary) return { ok: true, data: null };

    const canonical = summary.title || searchTitle;

    // Relevance gate: a "closest match" redirect (e.g. "Oriental Avenue" → "Bang Rak
    // subdistrict") can be totally unrelated to the clue. Real matches usually
    // surface a canonical-answer word in the lead sentence (e.g. "Autumn, also known
    // as Fall..." for clue answer "Fall"). If no canonical word appears in the lead,
    // skip the blurb rather than show a misleading one.
    if (!isLeadRelevant(rawQuery, summary.extract || "")) {
      return { ok: true, transient: true, data: null };
    }
    // Step 3 (parallel): Wikipedia redirects + Wikidata aliases.
    // Wikipedia redirects give nickname variants ("Jack Kennedy", "JFK")
    // Wikidata aliases give curated abbreviations that Wikipedia disambig pages
    // would otherwise hide ("TB" for Tuberculosis, "US" for United States).
    const [redirects, wikidataAliases] = await Promise.all([
      fetchRedirects(canonical),
      summary.wikibase_item
        ? fetchWikidataAliases(summary.wikibase_item)
        : Promise.resolve([]),
    ]);

    return {
      ok: true,
      data: {
        title: canonical,
        extract: summary.extract!,
        url: summary.content_urls?.desktop?.page || fallbackUrl,
        thumb: summary.thumbnail?.source ?? null,
        // Wikidata aliases first — they're curated and include critical
        // abbreviations (TB, US) that Wikipedia redirects miss.
        aliases: filterAliases(
          [canonical, searchTitle, ...wikidataAliases, ...redirects],
          canonical,
        ),
      },
    };
  } catch {
    return { ok: false, data: null };
  }
}
