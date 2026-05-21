import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const buzzerRouter = Router();

// Issue a fresh sessionId. The client passes this on every /clues/submit during
// the round, then calls /finish with the same id — at which point the server
// recomputes totals from the ClueResponse rows tagged with it.
buzzerRouter.post("/start", requireAuth, async (_req: AuthedRequest, res) => {
  const sessionId = crypto.randomBytes(16).toString("hex");
  res.json({ sessionId });
});

const finishSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

buzzerRouter.post("/finish", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = finishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { sessionId } = parsed.data;
  // Replay guard: a sessionId can only be finalized once.
  const existing = await prisma.buzzerSession.findUnique({
    where: { sessionId },
  });
  if (existing) {
    res.status(409).json({ error: "session already finished" });
    return;
  }
  const responses = await prisma.clueResponse.findMany({
    where: {
      userId: req.userId!,
      mode: "BUZZER",
      buzzerSessionId: sessionId,
    },
    include: { clue: { select: { value: true } } },
  });
  if (responses.length === 0) {
    res.status(400).json({ error: "no responses for session" });
    return;
  }
  // Dedupe by clueId — a client crash mid-submit followed by a resume can
  // produce two rows for the same clue in the same session. Latest wins.
  const byClue = new Map<number, (typeof responses)[number]>();
  for (const r of [...responses].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )) {
    if (!byClue.has(r.clueId)) byClue.set(r.clueId, r);
  }
  const final = Array.from(byClue.values());
  const totalClues = final.length;
  const correctCount = final.filter((r) => r.correct).length;
  const coryatScore = final.reduce(
    (s, r) => s + (r.correct ? r.clue.value : -r.clue.value),
    0,
  );
  const avgResponseMs = Math.round(
    final.reduce((s, r) => s + r.responseTimeMs, 0) / totalClues,
  );
  const session = await prisma.buzzerSession.create({
    data: {
      userId: req.userId!,
      sessionId,
      totalClues,
      correctCount,
      avgResponseMs,
      coryatScore,
    },
  });
  res.json({ session });
});

buzzerRouter.get("/history", requireAuth, async (req: AuthedRequest, res) => {
  const sessions = await prisma.buzzerSession.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  res.json({ sessions });
});
