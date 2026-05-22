import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const buzzerRouter = Router();

// Issue a fresh sessionId. The client passes this on every /clues/submit during
// the round, then calls /finish with the same id — at which point the server
// recomputes totals from the ClueResponse rows tagged with it.
/**
 * Handles the POST /start route or middleware callback.
 *
 * Parameters:
 * - `_req` (`AuthedRequest`): Caller-provided value consumed by the function body.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
buzzerRouter.post("/start", requireAuth, async (_req: AuthedRequest, res) => {
  const sessionId = crypto.randomBytes(16).toString("hex");
  res.json({ sessionId });
});

const finishSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

/**
 * Handles the POST /finish route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
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

/**
 * Handles the GET /history route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
buzzerRouter.get("/history", requireAuth, async (req: AuthedRequest, res) => {
  const sessions = await prisma.buzzerSession.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  res.json({ sessions });
});
