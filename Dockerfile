# ─── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ─── Stage 2: Build backend ───────────────────────────────────────────────────
FROM node:20-alpine AS backend-build
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
RUN npx prisma generate
RUN npm run build
# Strip devDependencies (typescript, vitest, supertest, @types/*) from the
# node_modules we ship — they're only needed for the build/test, not at runtime.
# prisma + tsx stay because the CMD invokes them on container start.
RUN npm prune --omit=dev

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app

# Compiled backend + deps
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/prisma ./prisma
COPY --from=backend-build /app/scripts ./scripts
# Tsx is needed to run the seed script (which is .ts, not compiled)
COPY --from=backend-build /app/package.json ./package.json

# Frontend build → /app/public (matches express.static lookup)
COPY --from=frontend-build /frontend/dist ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && if [ \"$SEED_DB\" = \"true\" ]; then npx tsx prisma/seed.ts; fi && exec node dist/index.js"]
