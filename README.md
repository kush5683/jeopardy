# Jeopardy! Trainer

Train on real Jeopardy-style clues, drill buzzer timing, run full boards, review missed clues, and study with flashcards.

Last deploy: Not recorded yet.

Production deployment details are intentionally kept out of source control.

## What This Repo Contains

- `frontend/`: React 18 + TypeScript + Vite client
- `backend/`: Express + TypeScript API with Prisma
- `backend/prisma/`: schema, migrations, seed data
- `docker-compose.yml` + `Dockerfile`: production-style container setup
- `deploy.sh`: rebuild/restart helper for the Docker deployment

## Core Features

- Practice mode with timers, category filtering, weak-category drills, optional voice input, and browser TTS
- Daily challenge with the same 30 clues for everyone each UTC day
- Buzzer training with lockouts, Coryat scoring, and saved session history
- Full board play in either real-episode or mixed-category mode, including Daily Doubles and Final Jeopardy
- Private live multiplayer rooms with server-authoritative board state, audience seats, rebuzzing after wrong answers, and keyboard buzz-in
- Spaced review queue built from missed clues
- Curated flashcard decks plus corpus-derived category decks
- Friends, leaderboards, and personal stats
- Wikipedia blurbs, alias enrichment, and LLM-generated hint text

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | Node 20, Express, TypeScript |
| Database | PostgreSQL 16 |
| ORM | Prisma |
| Auth | HttpOnly JWT session cookie, optional Google Sign-In |
| LLM | Local Ollama instance for answer judging, hinting, and wiki disambiguation |
| Deploy | Docker Compose |

## Quick Start

### Prerequisites

- Node.js 20+
- npm
- Docker Desktop or Docker Engine with Compose
- Optional: Ollama on the host machine
- Optional: Google OAuth client ID for Google Sign-In

### Local Development

1. Copy the environment file:

```bash
cp .env.example .env
```

2. Create the external Docker network expected by `docker-compose.yml`:

```bash
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
```

3. Start Postgres:

```bash
docker compose up -d db
```

4. Start the backend on the host:

```bash
cd backend
npm install
set -a; source ../.env; set +a
export DATABASE_URL="postgresql://jeopardy:${DB_PASSWORD}@127.0.0.1:5433/jeopardy"
npx prisma migrate dev
npm run dev
```

5. Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

6. Open `http://localhost:5173`.

Notes:

- The backend does not load `.env` by itself, so host-run development requires exporting env vars in your shell first.
- `frontend/vite.config.ts` proxies `/api` to `http://localhost:3000`.
- Browser auth now lives in an `HttpOnly` same-site cookie rather than `localStorage`.
- If Ollama is not running, deterministic judging still works; LLM-backed answer acceptance and hint generation degrade conservatively.

### Production-Like Local Run

```bash
cp .env.example .env
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
SEED_DB=true docker compose up -d --build
```

The container startup runs Prisma migrations automatically and optionally seeds the database when `SEED_DB=true`.

## Documentation

- [Development Guide](docs/development.md)
- [Architecture](docs/architecture.md)
- [API Reference](docs/api.md)
- [Game Modes](docs/game-modes.md)
- [Deployment Guide](docs/deployment.md)
- [Maintainer Handoff](handoff.md)

## Common Commands

```bash
# backend tests
cd backend && LLM_JUDGE_DISABLED=1 npm test

# backend lint
cd backend && npm run lint

# frontend lint
cd frontend && npm run lint

# rebuild and restart the app container
./deploy.sh
```

## Repository Layout

```text
.
├── backend/
│   ├── prisma/
│   ├── scripts/
│   ├── src/
│   └── test/
├── frontend/
│   └── src/
├── docs/
├── docker-compose.yml
├── Dockerfile
├── deploy.sh
└── handoff.md
```
