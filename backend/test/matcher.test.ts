import { describe, it, expect } from "vitest";
import { isCorrect } from "../src/routes/clues";

// Table-driven tests for the fuzzy answer matcher. Every case here corresponds
// to a documented behavior in clues.ts — when you change the matcher, run this
// suite to confirm you haven't regressed an edge case.

type Case = {
  submitted: string;
  canonical: string;
  aliases?: string[];
  expected: boolean;
  why: string;
};

const cases: Case[] = [
  // === Exact / trivial ===
  { submitted: "iowa", canonical: "Iowa", expected: true, why: "exact match (case-insensitive)" },
  { submitted: "  Iowa  ", canonical: "Iowa", expected: true, why: "leading/trailing whitespace stripped" },
  { submitted: "", canonical: "Iowa", expected: false, why: "empty submission" },

  // === Article and "what is" prefix stripping ===
  { submitted: "what is iowa", canonical: "Iowa", expected: true, why: "Jeopardy 'what is' prefix" },
  { submitted: "who is JFK", canonical: "JFK", expected: true, why: "'who is' prefix" },
  { submitted: "the moon", canonical: "Moon", expected: true, why: "leading article stripped" },
  { submitted: "Moon", canonical: "the Moon", expected: true, why: "leading article stripped on canonical" },

  // === Diacritics ===
  { submitted: "Beyonce", canonical: "Beyoncé", expected: true, why: "diacritics normalized away" },

  // === Single-word fuzzy ===
  { submitted: "iwoa", canonical: "Iowa", expected: true, why: "1-edit typo on single word" },
  { submitted: "Mississipi", canonical: "Mississippi", expected: true, why: "1-edit typo on long single word" },
  { submitted: "teh", canonical: "the", expected: false, why: "3-char canonical requires exact (and 'the' is a stopword anyway)" },
  { submitted: "ac", canonical: "DC", expected: false, why: "2-char canonical: 'AC' vs 'DC' = 1 edit but must reject" },

  // === Initialisms ===
  { submitted: "JFK", canonical: "John F. Kennedy", expected: true, why: "initialism of multi-word canonical" },
  { submitted: "FDR", canonical: "Franklin D. Roosevelt", expected: true, why: "initialism" },
  { submitted: "UN", canonical: "U.N.", expected: true, why: "initialism when all canonical tokens are single letters" },
  { submitted: "UN", canonical: "the U.N.", expected: true, why: "initialism with article" },

  // === Curated abbreviations ===
  { submitted: "TB", canonical: "Tuberculosis", expected: true, why: "curated alias for tuberculosis" },
  { submitted: "WWII", canonical: "World War II", expected: true, why: "curated alias for WWII" },
  { submitted: "Great Britain", canonical: "United Kingdom", expected: true, why: "curated alias for UK" },
  { submitted: "USA", canonical: "United States", expected: true, why: "curated alias for US" },
  { submitted: "guyser", canonical: "a geysor", expected: true, why: "curated alias rescues a misspelled canonical, then fuzzy accepts the contestant typo" },

  // === Wikipedia / wikidata aliases ===
  { submitted: "Teddy Roosevelt", canonical: "Theodore Roosevelt", aliases: ["Teddy Roosevelt", "TR"], expected: true, why: "alias from wiki redirects" },
  { submitted: "Autumn", canonical: "Fall", aliases: ["Autumn"], expected: true, why: "wikidata alias" },

  // === Parenthetical abbreviation in canonical ===
  { submitted: "AC", canonical: "alternating current (AC)", expected: true, why: "parenthetical abbreviation" },

  // === Word-boundary containment ===
  { submitted: "Lincoln", canonical: "Abraham Lincoln", expected: true, why: "user gave last name only" },
  { submitted: "louis x", canonical: "Louis XIV", expected: false, why: "substring containment must respect word boundaries — different kings" },

  // === Multi-word phrase alignment ===
  { submitted: "anne cleves", canonical: "Anne of Cleves", expected: true, why: "user dropped stopword 'of'" },
  { submitted: "anne bolin", canonical: "Anne of Cleves", expected: false, why: "different wife — 'bolin' doesn't match 'cleves'" },
  { submitted: "white men cant jump", canonical: "white men can't jump", expected: true, why: "contractions: apostrophe stripped, both become 'cant'" },
  { submitted: "white men can jump", canonical: "white men can't jump", expected: false, why: "'can' (4-char) requires exact, not 'cant'" },

  // === Word-level fuzzy on key word ===
  { submitted: "gibralter", canonical: "Strait of Gibraltar", expected: true, why: "longest key word fuzzy-matches" },
  { submitted: "louis x", canonical: "Louis XIV", expected: false, why: "user supplied wrong distinguishing token" },

  // === Multi-option canonicals (N of A, B or C) ===
  { submitted: "Milan Turin", canonical: "(2 of) Milan, Turin or Genoa", expected: true, why: "2 of 3 options" },
  { submitted: "Milan", canonical: "(2 of) Milan, Turin or Genoa", expected: false, why: "only 1 option given, need 2" },
  { submitted: "Milan Turin Florence", canonical: "(2 of) Milan, Turin or Genoa", expected: false, why: "extra non-option token" },

  // === Ampersand list canonicals ===
  { submitted: "Lewis Clark", canonical: "Lewis & Clark", expected: true, why: "both parts present" },
  { submitted: "Clark Lewis", canonical: "Lewis & Clark", expected: true, why: "order-independent" },
  { submitted: "Lewis", canonical: "Lewis & Clark", expected: false, why: "missing Clark" },
  { submitted: "Tajikistan Turkmenistan", canonical: "Tajikistan & Turkmenistan", expected: true, why: "both ~stan parts" },
  { submitted: "UI", canonical: "U & I", expected: true, why: "single-letter ampersand list, no separator" },
  { submitted: "U,I", canonical: "U & I", expected: true, why: "single-letter ampersand list with separator" },

  // === Short-canonical case ===
  { submitted: "on tv", canonical: "TV", expected: true, why: "≤3-char canonical matches as full token in user phrase" },

  // === Synonym groups (curated) ===
  { submitted: "summit", canonical: "top", expected: true, why: "mountain-top synonyms" },
  { submitted: "peak", canonical: "summit", expected: true, why: "mountain-top synonyms (reverse)" },
  { submitted: "top", canonical: "apex", expected: true, why: "synonym group is bidirectional" },
  { submitted: "base", canonical: "foot", expected: true, why: "bottom-of-mountain synonyms" },

  // === Number-word equivalence ===
  { submitted: "hang 10", canonical: "hanging ten", expected: true, why: "'10' = 'ten' and 'hang' is an inflection of 'hanging'" },
  { submitted: "5 alive", canonical: "five alive", expected: true, why: "digit ↔ word for low numbers" },
  { submitted: "ten", canonical: "10", expected: true, why: "single-token word ↔ digit" },

  // === Decade words ===
  { submitted: "90s", canonical: "nineties", expected: true, why: "decade digit form ↔ decade word" },
  { submitted: "nineties", canonical: "90s", expected: true, why: "reverse direction" },
  { submitted: "the 90s", canonical: "nineties", expected: true, why: "leading article stripped" },
  { submitted: "eighties", canonical: "80s", expected: true, why: "other decades work too" },

  // === Year-decade ↔ generic-decade aliasing ===
  { submitted: "nineties", canonical: "1990s", expected: true, why: "century-prefixed canonical accepts the generic word form" },
  { submitted: "1990s", canonical: "nineties", expected: true, why: "user can be more specific than the canonical" },
  { submitted: "90s", canonical: "the 1990s", expected: true, why: "article + year-decade canonical accepts short form" },
  { submitted: "twenties", canonical: "1820s", expected: true, why: "any century's year-decade matches the generic" },
  { submitted: "1990s", canonical: "1890s", expected: false, why: "two specific year-decades from different centuries do NOT match" },

  // === Inflection tolerance (-ing, -ed, -s) ===
  { submitted: "run", canonical: "running", expected: true, why: "verb-stem ↔ -ing" },
  { submitted: "running", canonical: "run", expected: true, why: "symmetric: -ing ↔ verb-stem" },
  { submitted: "married", canonical: "marry", expected: true, why: "y → i + ed" },
  { submitted: "loving", canonical: "love", expected: true, why: "drop-e + ing" },
  { submitted: "cars", canonical: "car", expected: true, why: "simple plural" },
  // Negative: inflection rule shouldn't accept unrelated words
  { submitted: "thing", canonical: "th", expected: false, why: "stem too short (< 3 chars) — inflection rule guards this" },

  // === Compound-word equivalence ===
  { submitted: "black beard", canonical: "Blackbeard", expected: true, why: "user split a compound proper noun" },
  { submitted: "Blackbeard", canonical: "black beard", expected: true, why: "reverse: user joined a multi-word canonical" },
  { submitted: "ice cream", canonical: "icecream", expected: true, why: "compound common noun, user split it" },
  { submitted: "louis x", canonical: "louisxiv", expected: false, why: "joined form still too far apart — different kings" },

  // === Partial answers accepted (forgiving) ===
  // The matcher accepts a partial answer if it's a word-bounded substring of
  // the canonical AND has no unmatched extra tokens. Generous, but consistent
  // with "Lincoln" matching "Abraham Lincoln" — same code path.
  { submitted: "Strait", canonical: "Strait of Gibraltar", expected: true, why: "word-bounded partial answer is accepted" },

  // === Compound wordplay canonicals must NOT accept fragment answers ===
  // Long pun/wordplay canonicals have 4+ important content words. Containment
  // is suppressed there so the LLM gets to judge whether every component was named.
  { submitted: "chicken scratch", canonical: "Attorney General Tso's chicken scratch", expected: false, why: "fragment of a multi-component pun — only named 1 of 3 components" },
  { submitted: "Attorney General", canonical: "Attorney General Tso's chicken scratch", expected: false, why: "another fragment of the same compound canonical" },
];

describe("isCorrect — fuzzy answer matcher", () => {
  for (const c of cases) {
    const label = `${c.expected ? "✓" : "✗"} "${c.submitted}" vs "${c.canonical}" — ${c.why}`;
    it(label, () => {
      expect(isCorrect(c.submitted, c.canonical, c.aliases)).toBe(c.expected);
    });
  }
});
