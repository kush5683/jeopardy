// Curated aliases for canonicals where Wikipedia redirects fall short — typically
// when the abbreviation has multiple meanings (disambiguation page) so Wikipedia
// won't redirect it to any single article. Keys are normalized canonical text
// (lowercase, basic punctuation stripped); values are accepted alternatives.
//
// Add freely. Keep keys lowercase. Each value will be matched via the full
// fuzzy matcher, so exact case + punctuation doesn't matter.

export const CURATED_ALIASES: Record<string, string[]> = {
  tuberculosis: ["TB"],
  "united states": ["US", "USA", "U.S.", "U.S.A.", "America"],
  "united states of america": ["US", "USA", "U.S.", "U.S.A.", "America"],
  "united kingdom": ["UK", "U.K.", "Britain", "Great Britain"],
  "anno domini": ["AD", "A.D."],
  "before christ": ["BC", "B.C."],
  "before common era": ["BCE", "B.C.E."],
  "common era": ["CE", "C.E."],
  "world war i": ["WWI", "WW1", "World War One", "the Great War", "First World War"],
  "world war ii": ["WWII", "WW2", "World War Two", "Second World War"],
  "new york city": ["NYC", "New York", "the Big Apple"],
  "los angeles": ["LA", "L.A."],
  "district of columbia": ["DC", "D.C.", "Washington D.C.", "Washington DC"],
  "washington d.c.": ["DC", "D.C.", "Washington DC"],
  geysor: ["geyser"],
  "deoxyribonucleic acid": ["DNA"],
  "ribonucleic acid": ["RNA"],
  "ante meridiem": ["AM", "A.M."],
  "post meridiem": ["PM", "P.M."],
  "miles per hour": ["mph", "MPH"],
  "miles per gallon": ["mpg", "MPG"],
  "frames per second": ["fps", "FPS"],
  "gross domestic product": ["GDP"],
  "central intelligence agency": ["CIA"],
  "federal bureau of investigation": ["FBI"],
  "national aeronautics and space administration": ["NASA"],
  "european union": ["EU", "E.U."],
  "soviet union": ["USSR", "U.S.S.R."],
  "people's republic of china": ["PRC", "China"],
};

// Synonym groups — bidirectional. When a clue's canonical answer is one of
// these everyday words, any other word in the same group is accepted. Keep
// each group tight: members should be near-perfect substitutes in the sense
// most likely to appear in a Jeopardy clue.
const SYNONYM_GROUPS: string[][] = [
  // top of a mountain / structure / chart
  ["top", "summit", "peak", "crest", "apex", "crown", "pinnacle", "tip", "zenith"],
  // bottom of a mountain / structure
  ["bottom", "base", "foot"],
];

const SYNONYM_LOOKUP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      m.set(word.toLowerCase(), group.filter((w) => w !== word));
    }
  }
  return m;
})();

// Normalize a canonical for lookup — same shape as the matcher's normalize
// but kept here so we don't depend on the matcher's internals.
function lookupKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getCuratedAliases(canonical: string): string[] {
  const key = lookupKey(canonical);
  const explicit = CURATED_ALIASES[key] ?? [];
  const synonyms = SYNONYM_LOOKUP.get(key) ?? [];
  return [...explicit, ...synonyms];
}
