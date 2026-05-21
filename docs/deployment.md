# Deployment Guide

## Production Components

The deployment model in this repo is intentionally simple:

- one Postgres container
- one app container
- Ollama running on the host machine, not in Docker

Files involved:

- `docker-compose.yml`
- `Dockerfile`
- `deploy.sh`
- root `.env`

## Compose Services

### `db`

- image: `postgres:16-alpine`
- published on `127.0.0.1:5433`
- data persisted in the `postgres_data` volume

### `app`

- built from the repo `Dockerfile`
- receives runtime env vars from Compose
- joins both the internal network and an external `reverse-proxy` network
- listens on port `3000`

## Environment for Deployment

The repo ships `.env.example`:

```dotenv
DB_PASSWORD=changeme
JWT_SECRET=replace-me-with-32+-bytes-of-random
DATABASE_URL=postgresql://jeopardy:changeme@db:5432/jeopardy
GOOGLE_CLIENT_ID=
SEED_DB=false
NODE_ENV=production
PORT=3000
```

Important notes:

- `DB_PASSWORD` is used by Compose to configure Postgres and to build the app container's `DATABASE_URL`
- Compose does not read the root `DATABASE_URL` for the app service; it constructs its own container-safe value from `DB_PASSWORD`
- the root `DATABASE_URL` is still useful when you source `.env` for host-run scripts, but it must be overridden for host development
- `GOOGLE_CLIENT_ID` is optional
- `OLLAMA_HOST` is not in `.env.example` but Compose will default it to `http://host.docker.internal:11434`

## Build and Startup Sequence

The multi-stage `Dockerfile` does this:

1. build the frontend in a `frontend-build` stage
2. build the backend and generate Prisma client in a `backend-build` stage
3. prune backend dev dependencies
4. copy compiled backend assets and built frontend files into the final image

Runtime container command:

```sh
npx prisma migrate deploy && \
if [ "$SEED_DB" = "true" ]; then npx tsx prisma/seed.ts; fi && \
exec node dist/index.js
```

That means every boot:

- applies pending migrations
- optionally seeds reference data
- starts the backend server

## First-Time Setup

Create the external network once:

```bash
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
```

Create the env file:

```bash
cp .env.example .env
```

Edit:

- `DB_PASSWORD`
- `JWT_SECRET`
- optional `GOOGLE_CLIENT_ID`
- optional `SEED_DB=true` for initial content load

## Deploy Commands

### Standard Deploy

```bash
./deploy.sh
```

What it does:

- verifies Docker exists
- tries to ensure Ollama is running on the host
- rebuilds the `app` image
- recreates the `app` container
- prints recent logs

### Force Rebuild Without Cache

```bash
./deploy.sh --no-cache
```

### Follow Logs After Deploy

```bash
./deploy.sh --logs
```

## Manual Compose Commands

Useful direct commands:

```bash
docker compose build app
docker compose up -d app
docker compose logs -f app
docker compose ps
```

## Ollama in Production

The backend uses Ollama for:

- ambiguous answer judging
- hint generation
- some Wikipedia-title disambiguation

Deployment assumptions:

- Ollama is running on the host
- the container can reach it at `host.docker.internal:11434`
- Docker Desktop resolves `host.docker.internal`

If Ollama is unavailable:

- the app still runs
- deterministic matching remains available
- LLM-backed features fail safe rather than accepting risky answers

## Reverse Proxy Expectations

`docker-compose.yml` includes:

- external network: `reverse-proxy`
- `traefik.enable=false` label on the app service

This repo does not manage the reverse proxy itself. The expected proxy or edge setup lives outside this codebase.

## Verifying a Deploy

After deploy, check:

```bash
docker compose logs --tail=25 app
curl -s http://localhost:3000/api/health
```

Expected health response:

```json
{ "ok": true }
```

For LLM availability:

```bash
curl -s http://localhost:11434/api/ps
```

## Database Operations

Open a SQL shell:

```bash
docker compose exec -T db psql -U jeopardy -d jeopardy
```

Schema changes should be deployed through Prisma migrations, not manual table edits.

## Troubleshooting

### Compose Fails Because `reverse-proxy` Does Not Exist

Create it once:

```bash
docker network inspect reverse-proxy >/dev/null 2>&1 || docker network create reverse-proxy
```

### App Starts but LLM Features Do Not Work

Check:

- Ollama is running on the host
- `OLLAMA_HOST` resolves from the container
- the desired model is installed

### App Boots but Auth Fails Immediately

Check that `JWT_SECRET` is set; the backend refuses to start without it.

### Frontend Loads but API Calls Fail

Check:

- the backend container is healthy
- port `3000` is reachable
- Prisma migrations succeeded during startup
