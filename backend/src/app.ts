import express from "express";
import path from "path";
import fs from "fs";
import { authRouter } from "./routes/auth";
import { cluesRouter } from "./routes/clues";
import { buzzerRouter } from "./routes/buzzer";
import { flashcardsRouter } from "./routes/flashcards";
import { friendsRouter } from "./routes/friends";
import { leaderboardRouter } from "./routes/leaderboard";
import { statsRouter } from "./routes/stats";
import { dailyRouter } from "./routes/daily";
import { reviewRouter } from "./routes/review";
import { preferencesRouter } from "./routes/preferences";
import { multiplayerRouter } from "./routes/multiplayer";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostIsLocal(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.startsWith("localhost:") ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.0.0.1:") ||
    normalized === "[::1]" ||
    normalized.startsWith("[::1]:")
  );
}

function headerOriginHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self' https://accounts.google.com/gsi/client https://apis.google.com",
    "connect-src 'self' https://accounts.google.com https://*.google.com https://*.googleapis.com https://*.gstatic.com",
    "frame-src 'self' https://accounts.google.com https://*.google.com",
  ].join("; ");
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    res.setHeader("Content-Security-Policy", contentSecurityPolicy());
    // OAuth / SSO popup flows need to retain a usable opener relationship so
    // the popup can post its result back to the app window.
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Origin-Agent-Cluster", "?1");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (host && !hostIsLocal(host)) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=15552000; includeSubDomains",
      );
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const host = (req.headers.host ?? "").toLowerCase();
    if (!host) {
      res.status(400).json({ error: "missing host header" });
      return;
    }
    const originHost =
      headerOriginHost(
        typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      ) ??
      headerOriginHost(
        typeof req.headers.referer === "string"
          ? req.headers.referer
          : undefined,
      );
    if (originHost && originHost !== host) {
      res.status(403).json({ error: "cross-site request blocked" });
      return;
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/clues", cluesRouter);
  app.use("/api/buzzer", buzzerRouter);
  app.use("/api/flashcards", flashcardsRouter);
  app.use("/api/friends", friendsRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/daily", dailyRouter);
  app.use("/api/review", reviewRouter);
  app.use("/api/preferences", preferencesRouter);
  app.use("/api/multiplayer", multiplayerRouter);

  // Serve frontend static files. In production (Dockerfile) frontend is copied to /app/public.
  // In dev (running from src), it's at ../../frontend/dist.
  const candidatePaths = [
    path.resolve(__dirname, "../public"),
    path.resolve(__dirname, "../../frontend/dist"),
  ];
  const frontendDist = candidatePaths.find((p) => fs.existsSync(p));
  if (frontendDist) {
    app.use(express.static(frontendDist));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  return app;
}
