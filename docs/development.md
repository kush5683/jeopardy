# Development Guide

## Prerequisites

- Node.js 20+
- npm
- Docker with Compose
- PostgreSQL runs through Docker in the default workflow
- Optional: Ollama on the host machine at `http://localhost:11434`
- Optional: Google OAuth client ID for Google Sign-In

## Environment Variables

The root `.env.example` is primarily a Docker Compose input file. The backend process reads `process.env` directly and does not load `.env` for you.

| Variable | Required | Used By | Notes |
| --- | --- | --- | --- |
| `DB_PASSWORD` | yes for Compose | `docker-compose.yml` | Password for the Postgres container |
| `JWT_SECRET` | yes | backend, daily clue salt, JWT signing | Required at process startup |
| `DATABASE_URL` | yes for backend process | Prisma | For host-run backend, point to `127.0.0.1:5433`; inside Docker, Compose injects `db:5432` |
| `GOOGLE_CLIENT_ID` | optional | `/api/auth/google`, `/api/auth/config` | Enables Google Sign-In |
| `SEED_DB` | optional | container startup | `true` runs `backend/prisma/seed.ts` after migrations |
| `NODE_ENV` | optional | backend | Usually `development`, `test`, or `production` |
| `PORT` | optional | backend | Defaults to `3000` |
| `OLLAMA_HOST` | optional | LLM judge, hints, wiki chooser | Defaults to `http://localhost:11434` on host, `http://host.docker.internal:11434` in Docker |
| `LLM_JUDGE_MODEL` | optional | `backend/src/lib/llmJudge.ts` | Defaults to `qwen2.5:7b` |
| `LLM_JUDGE_DISABLED` | optional | tests or local fallback | Set to `1` to skip all LLM calls |
| `LLM_JUDGE_TIMEOUT_MS` | optional | LLM judge | Defaults to `4000` |
| `DATABASE_URL_TEST` | optional | Vitest setup | Override the test database connection |

## Local Workflow

### 1. Bootstrap the Environment

```bash
cp .env.example .env
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
docker compose up -d db
```

Why the extra network step:

- `docker-compose.yml` declares an external `reverse-proxy` network for the app service.
- If that network does not exist, Compose can fail before starting containers.

### 2. Run the Backend on the Host

```bash
cd backend
npm install
set -a; source ../.env; set +a
export DATABASE_URL="postgresql://jeopardy:${DB_PASSWORD}@127.0.0.1:5433/jeopardy"
npx prisma migrate dev
npm run dev
```

Important details:

- The host-run backend cannot use the container hostname `db`; it must connect through the published port on `127.0.0.1:5433`.
- `backend/src/middleware/auth.ts` throws immediately if `JWT_SECRET` is missing.
- `backend/src/index.ts` starts the server and then prewarms the LLM judge model.

### 3. Run the Frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server listens on `http://localhost:5173` and proxies `/api` to `http://localhost:3000`.

### 4. Optional: Run Ollama

If you want the full answer-judging and hint-generation behavior:

```bash
ollama list
ollama pull qwen2.5:7b
ollama serve
```

Without Ollama:

- deterministic matching still runs
- ambiguous answers that rely on the LLM fallback are more likely to be rejected
- hint generation and wiki-title disambiguation fail safe

## Production-Style Local Run

```bash
cp .env.example .env
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
SEED_DB=true docker compose up -d --build
```

This path builds the frontend, compiles the backend, applies Prisma migrations, optionally seeds, and serves the frontend from Express static files.

## Tests

### Backend Tests

```bash
cd backend
LLM_JUDGE_DISABLED=1 npm test
```

Relevant behavior:

- Vitest is configured in `backend/vitest.config.ts`.
- Tests run serially in a single fork because they share one test database.
- `backend/test/setup.ts` applies pending migrations once and truncates mutable tables before each test.
- If your local test database credentials differ from the repo's default assumption, set `DATABASE_URL_TEST` explicitly.

### Linting

```bash
cd backend && npm run lint
cd frontend && npm run lint
```

## Database Work

### Apply or Create Migrations

```bash
cd backend
npx prisma migrate dev --name your_change
npx prisma generate
```

Rules already followed by the repo:

- schema changes are additive migrations in `backend/prisma/migrations/`
- old migrations are not edited in place
- Prisma types should be regenerated after schema changes

### Seed Reference Data

```bash
cd backend
npx prisma db seed
```

The seed script loads:

- `backend/prisma/clues.json`
- `backend/prisma/flashcards.json`

### Open a SQL Shell

```bash
docker compose exec -T db psql -U jeopardy -d jeopardy
```

## Importing Larger Clue Sets

The repository includes `backend/scripts/import-jarchive.ts` for importing external clue dumps into Postgres.

Before using it:

- inspect the script and expected input format
- expect imported data to affect `Clue`, `Category`, Wikipedia enrichment, and matcher behavior
- re-run matcher tests if imported data exposes new answer patterns

## Frontend Behavior Worth Knowing

- Auth state is stored in `localStorage` via `frontend/src/contexts/AuthContext.tsx`.
- The shared API client in `frontend/src/api/client.ts` automatically attaches the JWT.
- A `401` response clears saved auth and redirects to `/login` when appropriate.
- Practice, Buzzer, and Board persist some in-progress state in `localStorage` to support refresh recovery.

## Common Gotchas

### `.env` Is Not Auto-Loaded

The backend does not use `dotenv` or Node's `--env-file`. If you start the backend directly, export the variables first.

### Host vs Container `DATABASE_URL`

- Host-run backend: `postgresql://jeopardy:${DB_PASSWORD}@127.0.0.1:5433/jeopardy`
- App container: `postgresql://jeopardy:${DB_PASSWORD}@db:5432/jeopardy`

### The Test Database Is Separate

Tests should not share the development database. Use `DATABASE_URL_TEST` when needed.

### Ollama Lives Outside Docker

The app container expects Ollama on the host via `host.docker.internal:11434`.

### Matcher Changes Need Tests

Answer-matching regressions are one of the highest-risk areas. Add or update cases in `backend/test/matcher.test.ts` whenever matching behavior changes.
