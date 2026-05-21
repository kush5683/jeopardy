# Architecture

## System Overview

This project is a full-stack Jeopardy training app with a React frontend, an Express API, a Postgres database, and an optional local LLM layer for ambiguous answer evaluation and content enrichment.

High-level flow:

1. The frontend requests clue sets or decks from the backend.
2. Users answer through a mode-specific page.
3. The backend first applies deterministic answer matching.
4. If deterministic matching rejects the answer, the backend can ask Ollama for a conservative yes-or-no verdict.
5. Authenticated submissions are persisted as `ClueResponse` rows and feed stats, review scheduling, leaderboards, and buzzer history.

## Repository Layout

```text
backend/
  prisma/
    schema.prisma
    migrations/
    seed.ts
  scripts/
    import-jarchive.ts
  src/
    app.ts
    index.ts
    lib/
    middleware/
    routes/
  test/
frontend/
  src/
    api/
    components/
    contexts/
    hooks/
    pages/
```

## Runtime Topology

### Frontend

- React app bootstrapped from `frontend/src/main.tsx`
- Route tree defined in `frontend/src/App.tsx`
- Uses `axios` through `frontend/src/api/client.ts`
- In development, Vite proxies API requests to `localhost:3000`

### Backend

- `backend/src/app.ts` creates the Express app and mounts all `/api/*` routers
- `backend/src/index.ts` starts the HTTP server and prewarms the LLM judge
- In production, the backend also serves `frontend/dist` as static files

### Database

- Prisma schema lives in `backend/prisma/schema.prisma`
- Postgres is the source of truth for users, clue corpus, responses, review schedules, and persisted LLM acceptances

### LLM Services

- Ollama runs outside Docker on the host machine
- The backend uses it for:
  - ambiguous answer judging
  - hint generation
  - Wikipedia title disambiguation

## Frontend Structure

### Pages

Main routes under `frontend/src/pages/`:

- `Home`
- `Login`, `Register`, `Settings`
- `Practice`
- `Daily`
- `Buzzer`
- `Review`
- `Board`
- `MultiplayerBoard`
- `FinalJeopardy`
- `Flashcards`
- `Friends`
- `Leaderboard`
- `Dashboard`

### Shared UI

Notable components:

- `Navbar`: route navigation and auth-aware menus
- `Hint`: polls for LLM-generated hint text
- `WikiBlurb`: shows clue-related Wikipedia metadata
- `TimerBar`: mode-specific countdown UI
- `MetaCategoryChips`: category filtering control for practice and buzzer
- `OfflineBanner`, `RetryPanel`, `ErrorBoundary`: resilience helpers

### Client State Patterns

- Auth state is bootstrapped from `/api/auth/me`; the browser credential itself lives in an `HttpOnly` same-site cookie
- API `401`s redirect to login
- Some in-progress game state is also persisted locally for resume-on-refresh behavior
- Browser-native speech APIs are used for optional text-to-speech and voice recognition

## Backend Structure

### App Factory and Routing

`backend/src/app.ts` mounts:

- `/api/auth`
- `/api/clues`
- `/api/buzzer`
- `/api/flashcards`
- `/api/friends`
- `/api/leaderboard`
- `/api/stats`
- `/api/daily`
- `/api/review`
- `/api/preferences`
- `/api/multiplayer`

This separation keeps tests able to import the app without starting a real server.
It also centralizes baseline response headers and a same-origin guard for
mutating browser requests.

### Middleware

- `middleware/auth.ts`: required and optional JWT auth
- `middleware/rateLimit.ts`: IP-based rate limiting for auth, friend requests, and answer submission

### Libraries

- `lib/prisma.ts`: Prisma client singleton
- `lib/llmJudge.ts`: answer judging, hint generation, model prewarming, in-flight serialization
- `lib/wikipedia.ts`: article lookup, alias extraction, relevance checks
- `lib/warmWikiCache.ts`: background fetcher for wiki data
- `lib/curatedAliases.ts`: hand-maintained canonical aliases for the matcher
- `multiplayer/service.ts`: room lifecycle, websocket fanout, reconnect handling, and server-authoritative game state

## Data Model

Key Prisma models:

| Model | Purpose |
| --- | --- |
| `User` | account identity, display name, auth bindings, preferences |
| `Category` | category name plus meta-category tags |
| `Clue` | question/answer content, round, value, Wikipedia fields, hint cache |
| `ClueResponse` | every authenticated judged answer across all play modes |
| `BuzzerSession` | finalized buzzer rounds with Coryat and timing stats |
| `DailyAttempt` | one saved result per user per UTC day |
| `ReviewSchedule` | spaced-review queue entries for missed clues |
| `FlashcardDeck` / `Flashcard` / `UserFlashcard` | curated study decks and per-user progress |
| `Friendship` | pending and accepted friend relationships |
| `MultiplayerRoom` / `MultiplayerPlayer` | persisted private multiplayer rooms and player seats |
| `AcceptedLLMVerdict` | persisted positive LLM judge decisions keyed by normalized answer pair |

Enums used across the system:

- `Round`: `JEOPARDY`, `DOUBLE_JEOPARDY`, `FINAL_JEOPARDY`
- `PlayMode`: `PRACTICE`, `BUZZER`, `DAILY`, `REVIEW`, `BOARD`, `FINAL`

## Answer Evaluation Pipeline

The answer path is centered in `backend/src/routes/clues.ts`.

### Step 1: Deterministic Matching

`isCorrect(submitted, canonical, aliases)` handles:

- case, punctuation, articles, and diacritics
- fuzzy single-word matching
- initialisms
- alias expansion
- inflection tolerance
- decade and number-word normalization
- partial-name containment
- special handling for compound and multi-option answers

The matcher is intentionally conservative in high-risk cases such as multi-part puns.

### Step 2: LLM Fallback

If deterministic matching rejects the answer:

- `judgeWithLLM()` asks Ollama for a strict yes-or-no verdict
- only a response beginning with `yes` is treated as accepted
- failures, timeouts, or malformed outputs resolve to rejection

### Step 3: Persistence

For authenticated play, the backend writes a `ClueResponse` and returns:

- whether the answer was accepted
- the canonical answer
- the score delta
- whether the LLM was consulted

### Step 4: Review Scheduling

If the final verdict is wrong:

- the backend schedules the clue into `ReviewSchedule`
- later review attempts grow or reset the interval in `routes/review.ts`

## Hint Pipeline

Hints are LLM-generated, clue-specific post-hoc explanations.

Flow:

1. The frontend calls `POST /api/clues/:id/hint/prepare` when a clue first appears.
2. The backend starts a background job unless the hint is already cached or already in flight.
3. The frontend polls `GET /api/clues/:id/hint`.
4. When the job completes, `Clue.hintText` and `Clue.hintFetchedAt` are stored permanently.

Design goals:

- fire-and-forget kickoff
- deduplicated in-flight work
- silent failure rather than blocking gameplay

## Wikipedia Enrichment Pipeline

Each clue can expose a Wikipedia summary and alias list.

Flow:

1. A clue set is loaded.
2. `warmWikiCache()` opportunistically starts background fetches.
3. The first explicit wiki request can also fetch on demand.
4. Successful non-transient results are cached back onto the `Clue` row.

Data captured on the clue:

- `wikiTitle`
- `wikiExtract`
- `wikiUrl`
- `wikiThumb`
- `wikiAliases`
- `wikiFetchedAt`

Those aliases feed back into the answer matcher.

## Auth and Session Model

- JWTs are signed with `JWT_SECRET`
- tokens expire after 30 days
- the browser app stores the JWT in an `HttpOnly` same-site cookie scoped to `/api`
- authenticated routes accept that cookie and can also honor `Authorization: Bearer <token>` for internal tooling
- optional auth is used where anonymous access still makes sense, such as the global leaderboard or flashcard deck inspection
- the multiplayer websocket upgrade is authenticated from that same session cookie

## Rate Limiting

Defined in `backend/src/middleware/rateLimit.ts`:

- auth endpoints: 10 requests/minute per client IP
- friend requests: 10 requests/minute per client IP
- clue submission/checking: 120 requests/minute per client IP

Cloudflare and proxy headers are handled manually to avoid enabling global `trust proxy`.

## Deployment Model

- The Docker image builds frontend and backend in separate stages
- The runtime image contains compiled backend code, Prisma assets, and built frontend files
- Container startup runs `prisma migrate deploy`
- If `SEED_DB=true`, startup also runs `prisma/seed.ts`
- The app listens on port `3000`

See [Deployment Guide](deployment.md) for the operational workflow.
