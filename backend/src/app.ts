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

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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
