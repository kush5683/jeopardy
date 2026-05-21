# Jeopardy Project — Handoff

This document explains the project, the user's working style, and how an
assistant (Claude or human) should operate in this codebase. Read it before
making changes if you're picking up cold.

---

## 1. Project overview

A web-based Jeopardy! trainer. Users play through real Jeopardy clues across
several modes, get judged on their answers, and build a spaced-repetition
review queue from misses.

- **Owner:** Kush Shah (kush@kushshah.net, also reachable as
  shah.kush6@northeastern.edu).
- **Production hostname:** `jeopardy.kushshah.net` (the Wikipedia fetch UA in
  `backend/src/lib/wikipedia.ts` confirms this).
- **Status:** Active development. The codebase is real-use, not a toy.

### Play modes (`frontend/src/pages/`)

All modes share `/api/clues/submit` (logged-in) or `/api/clues/check`
(anonymous) as the judge endpoint, so backend behavior is consistent everywhere.

| Mode | File | Notes |
|---|---|---|
| Practice | `Practice.tsx` | Single-clue flow with a 15s timer |
| Daily | `Daily.tsx` | Fixed-set daily challenge, score saved server-side |
| Buzzer | `Buzzer.tsx` | Multi-clue session that mimics buzzer timing |
| Review | `Review.tsx` | SRS — only clues the user previously missed |
| Board | `Board.tsx` | Full episode: Jeopardy + Double + Final, wagering |
| FinalJeopardy | `FinalJeopardy.tsx` | Standalone Final-only practice |

---

## 2. Architecture

### Stack
- **Backend:** Node 20, Express, TypeScript, Prisma over Postgres 16.
- **Frontend:** React + Vite + Tailwind. Compiled into `frontend/dist/` and
  served as static files by the Express app in production.
- **DB:** Postgres in a Docker container. Dev/prod share the same compose
  stack; tests use a separate `jeopardy_test` DB on `127.0.0.1:5433`.
- **LLM:** Local Ollama (`qwen2.5:7b` is the default judge model;
  `llama3.2:3b` is also pulled). Ollama runs on the **host**, not inside
  Docker — the backend container reaches it via `host.docker.internal:11434`.

### Repo layout
```
/Users/kushlab/jeopardy/
├── backend/
│   ├── src/
│   │   ├── app.ts                   # Express app factory (used by tests too)
│   │   ├── index.ts                 # Production entry: starts server + prewarms LLM
│   │   ├── lib/
│   │   │   ├── prisma.ts            # Prisma client singleton
│   │   │   ├── wikipedia.ts         # Wikipedia/Wikidata fetch + LLM ranking
│   │   │   ├── llmJudge.ts          # All LLM-backed helpers (judge, hint, wiki picker)
│   │   │   ├── curatedAliases.ts    # Hand-curated answer aliases
│   │   │   └── warmWikiCache.ts     # Background wiki fetcher
│   │   ├── routes/
│   │   │   ├── clues.ts             # Main clue endpoints + fuzzy matcher
│   │   │   ├── auth.ts, buzzer.ts, daily.ts, review.ts, etc.
│   │   └── middleware/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/              # Filenames are YYYYMMDDHHMMSS_name
│   │   ├── seed.ts                  # Runs in prod container on every boot
│   │   └── clues.json               # Seed data
│   ├── test/                        # Vitest, hits real test DB
│   └── scripts/import-jarchive.ts   # Imports j-archive TSV dumps
├── frontend/
│   └── src/
│       ├── pages/                   # One file per route/mode
│       ├── components/              # Hint, WikiBlurb, TimerBar, etc.
│       ├── hooks/
│       └── contexts/
├── deploy.sh                        # Rebuild + restart app container
├── docker-compose.yml               # db + app services
└── handoff.md                       # This file
```

### Key data model
- `Clue` — `question`, `answer`, `wikiTitle/Extract/Url/Thumb/Aliases`,
  `hintText`/`hintFetchedAt` (LLM-generated post-hoc hint).
- `Category` — `name`, with `@@unique([name])`.
- `ClueResponse` — every submit is persisted with `correct`, mode, wager,
  timing. Powers stats, weak-category drills, and the SRS review queue.
- `AcceptedLLMVerdict` — persisted YES verdicts from the LLM judge keyed by
  `(canonical, submitted)` so we never re-ask for an answer the LLM already
  accepted.

---

## 3. User profile and working style

These are persistent preferences. Memory files at
`~/.claude/projects/-Users-kushlab-jeopardy/memory/` also encode some of this.

### Goals
- **Make judging feel right.** The biggest active workstream is "the matcher
  shouldn't reject answers a Jeopardy! host would accept, and shouldn't
  accept ones a host would reject." Every time he reports a false reject or
  false accept, treat it as a real bug. Add a test for the case.
- **Use local LLMs as a safety net.** The deterministic matcher in
  `clues.ts` is the first pass; the LLM (Ollama) is the fallback for things
  edit-distance + heuristics can't handle (puns, spelling variants, real-name
  vs. pen-name). The LLM must never make the system *worse* — it's only
  consulted when the deterministic matcher rejects.
- **No regressions across modes.** Features are mode-agnostic by default
  (see §5).

### Collaboration preferences
- **Terse responses.** End-of-turn summaries should be 1–2 sentences plus
  optional bullet list of changed files. No marketing language.
- **Don't ask about scope of features.** If something belongs on the result
  panel of one mode, it belongs on all of them. Only ask if there's a real
  ambiguity. The memory file `mode_agnostic_features.md` exists because he
  pushed back on me asking.
- **Implementations land, not proposals.** For exploratory questions
  ("can we…", "what could we do…") give a brief recommendation with the main
  tradeoff and ask before committing. For directive messages ("yeah", "do
  it", "add X"), implement directly.
- **He scrutinizes correctness.** When showing test results or LLM outputs,
  expect him to flag wrong-looking cases (e.g. "Louis X vs Louis XIV → YES
  shouldn't be accepted"). Verify factually before claiming something works.
- **Trust him to handle his own infrastructure.** He installed Ollama in the
  middle of a session, ran his own migrations when asked. Don't over-explain
  basic steps. Confirm before destructive actions (DB drops, force pushes),
  but for ordinary rebuilds (`./deploy.sh`) just do them.

---

## 4. How to operate

### Deploying
```bash
./deploy.sh              # rebuild backend image + restart container
./deploy.sh --no-cache   # force fresh build
./deploy.sh --logs       # tail logs after deploy
```
- The Dockerfile's `CMD` runs `npx prisma migrate deploy` before the server
  starts, so migrations apply on every boot.
- Seeding (`SEED_DB=true`) runs automatically after migrations.
- The app container reaches Postgres via the `db:5432` hostname (Docker
  internal DNS); reaches Ollama via `host.docker.internal:11434`
  (configured in `docker-compose.yml`).

### Running tests
```bash
cd backend
LLM_JUDGE_DISABLED=1 npx vitest run              # all tests
LLM_JUDGE_DISABLED=1 npx vitest run test/matcher.test.ts
```
- The `LLM_JUDGE_DISABLED=1` env var stops the test from trying to reach
  Ollama. Matcher tests are table-driven in `test/matcher.test.ts` — every
  judge case the user reports should get an entry here.
- The Vitest setup auto-applies pending migrations to `jeopardy_test`.

### Manual DB access
```bash
docker compose exec -T db psql -U jeopardy -d jeopardy
```
- Don't mutate prod-like data without confirming. New tables / columns are
  fine via migrations; data UPDATEs warrant a heads-up.

### Ollama
- Brew-installed (`brew services list` shows `ollama` running).
- Configured to only run one inference at a time via the LaunchAgent at
  `~/Library/LaunchAgents/local.ollama-env.plist` (which sets
  `OLLAMA_NUM_PARALLEL=1` at login before Ollama starts).
- Pulling new models: `ollama pull <name>`.
- `ollama list` to see installed.

### Frontend dev
- Frontend is built into `frontend/dist/` at Docker build time and copied
  into the image as static assets. There's no separate dev server in this
  setup — to test frontend changes, run `./deploy.sh`. (If a `vite dev`
  workflow gets added later, this section is stale — check `deploy.sh`.)

---

## 5. Key subsystems

### 5.1 Deterministic answer matcher (`backend/src/routes/clues.ts`)
`isCorrect(submitted, canonical, aliases)` — the workhorse. Implements:

- Article/"what is" prefix stripping, diacritics, case-insensitive
- Single-word fuzzy (Damerau-Levenshtein, length-based threshold)
- Initialisms ("JFK" → "John F. Kennedy")
- Multi-word phrase alignment (handles dropped stopwords)
- Curated aliases (`curatedAliases.ts`) — TB, US, WWII, etc.
- Wikipedia/Wikidata redirect aliases (persisted on the Clue row)
- Decade-word equivalence ("nineties" ↔ "90s" ↔ "1990s")
- Inflection tolerance (run/running/runs)
- Number-word substitution ("hang 10" ↔ "hanging ten")
- Multi-option canonicals (`"(2 of) Milan, Turin or Genoa"`)
- Ampersand-list canonicals (`"Lewis & Clark"`)
- Word-boundary containment (partial-name answers)
- Compound wordplay guard — when canonical has 4+ important words,
  containment and word-level fuzzy fallbacks are suppressed (so a 2-word
  fragment of a 5-word pun like "Attorney General Tso's chicken scratch"
  doesn't slip through). Forces the LLM to judge.

When you change this file, run the matcher tests. Add a test for the bug.

### 5.2 LLM judge (`backend/src/lib/llmJudge.ts`)
Called from `/submit` and `/check` **only** when `isCorrect` returns false.

- **Model:** `qwen2.5:7b` by default. Configurable via `LLM_JUDGE_MODEL`.
  The 7B is needed — 3B was too small to distinguish "Greensborough"
  (spelling variant) from "Charlotte" (different city) reliably.
- **Prompt:** few-shot with positive AND negative examples (the negatives
  are load-bearing — without them, the model accepts everything).
- **Conservative parsing:** only `/^\s*yes\b/i` counts as a YES. Anything
  else, including network failures, returns false — so the deterministic
  verdict always stands as the floor.
- **Mutex:** A promise-chain queue serializes ALL LLM calls process-wide
  (judge, hint, wiki picker) so we never have multiple inferences in
  flight. Belt-and-suspenders: `OLLAMA_NUM_PARALLEL=1` caps the Ollama
  side too.
- **Caching:** Two layers.
  - In-memory `Map<key, true>` with FIFO eviction (~1000 entries).
  - Postgres `AcceptedLLMVerdict` table keyed on
    `(canonical_lower, submitted_lower)`. Only YES verdicts are persisted —
    rejected ones are re-asked in case prompts/models improve.
- **Prewarming:** `prewarmLLMJudge()` runs on `app.listen()` to load the
  model into Ollama's memory. Without it, the first real submission pays a
  ~15s cold start.

### 5.3 Hint system
LLM-generated post-hoc explanation of how a clue's wordplay points to the
answer. Auto-shown on every result panel.

- **Schema:** `Clue.hintText`, `Clue.hintFetchedAt`. Cached forever per clue.
- **Generation path:**
  - Frontend fires `POST /api/clues/:id/hint/prepare` when the clue first
    appears on screen — fire-and-forget, returns 202 immediately.
  - Backend kicks off a background job, deduplicated by `inFlightHints`
    `Map<clueId, Promise>`. A second prepare for the same clue joins the
    existing job.
  - When generation completes, the hint is written to the DB.
- **Display:** `<Hint clueId={...} />` (frontend component) polls
  `GET /api/clues/:id/hint` every 1.2s. Renders "Generating hint…" while
  pending, the hint as a small italic line when ready, gives up silently
  after ~30s.
- **Cancellation:** Frontend unmount stops polling. The background LLM call
  still completes and caches for the next viewer (no wasted compute).
  This is intentional — the user said "nice to haves but I don't want them
  getting in the way."

### 5.4 Wikipedia fetching (`backend/src/lib/wikipedia.ts`)
Each clue gets a wiki blurb shown on the result panel. Two callers:
direct fetch on first viewing, and `warmWikiCache` (background pre-fetcher
called when a batch of clues is loaded).

- **Disambiguation:** Categories often have ambiguous canonicals
  ("Pump" → band album vs. mechanical vs. shoe). When opensearch returns
  2+ candidates and the clue text is available, `pickWikiTitleWithLLM`
  asks the LLM which title best matches given the clue context. The LLM
  only picks from real titles, so no hallucination risk.
- **Aliases:** Filtered list of Wikipedia redirects + Wikidata aliases gets
  written to `Clue.wikiAliases` and feeds back into the answer matcher.
- **Relevance gate:** rejects "closest match" pages where no canonical word
  appears in the lead sentence.

---

## 6. Conventions to follow

- **Default to mode-agnostic.** If a feature touches one of
  `pages/{Practice,Daily,Buzzer,Review,Board,FinalJeopardy}.tsx`, apply the
  same change to the others. Don't ask first.
- **LLM features must fail safe.** Any network/timeout/parse failure
  returns the conservative answer (false for judge, null for hint, no
  reorder for wiki). The deterministic verdict is always the floor.
- **Tests are the source of truth for matcher behavior.** Every reported
  judging bug should get a case in `test/matcher.test.ts` — both the
  positive (this should accept) and the negative (and this similar-looking
  thing should still reject).
- **Schema changes are migrations.** Don't edit prior migrations. New file
  in `prisma/migrations/<timestamp>_name/migration.sql`, then
  `npx prisma generate` so TypeScript types update.
- **Don't proactively write docs.** This file is an exception because it
  was explicitly requested. Don't create READMEs, CHANGELOGs, or summary
  files unless asked.
- **Don't add backwards-compat shims.** When deleting code, delete cleanly.

---

## 7. Common gotchas

- **Ollama on macOS.** Brew regenerates the launchd plist on
  `brew services restart`, wiping any manual edits. To persist env vars
  across restarts use the separate LaunchAgent at
  `~/Library/LaunchAgents/local.ollama-env.plist`, which runs
  `launchctl setenv` at login before Ollama starts.
- **Docker can't see host services.** Ollama runs on the host;
  inside containers `localhost` is the container. Use
  `host.docker.internal:11434`. The compose file maps this with
  `extra_hosts: ["host.docker.internal:host-gateway"]`.
- **The jarchive importer escapes apostrophes as `\'`.** All sources should
  unescape both `\"` and `\'` (`import-jarchive.ts`). If you see stray
  backslashes in `Category.name`, `Clue.question`, or `Clue.answer`,
  someone re-imported with the old script — `REPLACE(col, E'\\''', '''')`
  fixes it in place.
- **Prisma client regen.** After schema changes, run
  `npx prisma generate` in `backend/` — TypeScript won't know about new
  models otherwise. Tests run their own generate via the Vitest setup, so
  test-only flow works, but the dev type-check needs it.
- **Test DB is separate.** `jeopardy_test` on `127.0.0.1:5433`. Don't
  expect tests and the dev DB to share data.

---

## 8. Quick reference

```bash
# Deploy
./deploy.sh

# Backend tests
cd backend && LLM_JUDGE_DISABLED=1 npx vitest run

# Type check
cd backend  && npx tsc --noEmit
cd frontend && npx tsc --noEmit

# DB shell
docker compose exec -T db psql -U jeopardy -d jeopardy

# Tail backend logs
docker compose logs -f app

# Inspect Ollama
ollama list
curl -s http://localhost:11434/api/ps
```

### Environment variables (backend)

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection |
| `JWT_SECRET` | — | Session signing |
| `OLLAMA_HOST` | `http://localhost:11434` (container: `host.docker.internal:11434`) | Ollama endpoint |
| `LLM_JUDGE_MODEL` | `qwen2.5:7b` | Model name |
| `LLM_JUDGE_DISABLED` | unset | Set to `1` to skip LLM (tests use this) |
| `LLM_JUDGE_TIMEOUT_MS` | `4000` | Per-call abort timeout |
| `SEED_DB` | `false` | Run seed.ts on container boot |

---

When you take over a new session, read this file, then check `git log`
for what's changed since it was written. The handoff is a snapshot, not
a substitute for looking at current state.
