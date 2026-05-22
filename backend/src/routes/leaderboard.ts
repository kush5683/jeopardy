import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, optionalAuth, requireAuth } from "../middleware/auth";
import { FriendshipStatus } from "@prisma/client";

export const leaderboardRouter = Router();

type Row = {
  userId: string;
  displayName: string;
  totalAnswered: number;
  correctCount: number;
  accuracy: number;
  bestCoryat: number;
};

/**
 * Builds rows data.
 *
 * Parameters:
 * - `userIds` (`string[] | null`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Promise<Row[]>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
async function buildRows(userIds: string[] | null): Promise<Row[]> {
  const userWhere = userIds
    ? { id: { in: userIds }, isTestAccount: false }
    : { isTestAccount: false };
  const users = await prisma.user.findMany({
    where: userWhere,
    select: { id: true, displayName: true },
  });
  const visibleIds = users.map((u) => u.id);

  const responses = await prisma.clueResponse.groupBy({
    by: ["userId"],
    where: { userId: { in: visibleIds } },
    _count: { _all: true },
  });

  const correct = await prisma.clueResponse.groupBy({
    by: ["userId"],
    where: { correct: true, userId: { in: visibleIds } },
    _count: { _all: true },
  });
  const correctMap = new Map(correct.map((r) => [r.userId, r._count._all]));

  const buzzer = await prisma.buzzerSession.groupBy({
    by: ["userId"],
    where: { userId: { in: visibleIds } },
    _max: { coryatScore: true },
  });
  const coryatMap = new Map(
    buzzer.map((r) => [r.userId, r._max.coryatScore ?? 0]),
  );
  const responsesMap = new Map(responses.map((r) => [r.userId, r._count._all]));

  const rows: Row[] = users.map((u) => {
    const total = responsesMap.get(u.id) ?? 0;
    const c = correctMap.get(u.id) ?? 0;
    return {
      userId: u.id,
      displayName: u.displayName,
      totalAnswered: total,
      correctCount: c,
      accuracy: total ? c / total : 0,
      bestCoryat: coryatMap.get(u.id) ?? 0,
    };
  });
  rows.sort((a, b) => {
    if (b.bestCoryat !== a.bestCoryat) return b.bestCoryat - a.bestCoryat;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return b.totalAnswered - a.totalAnswered;
  });
  return rows;
}

/**
 * Handles the GET /global route or middleware callback.
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
 */
leaderboardRouter.get("/global", optionalAuth, async (req: AuthedRequest, res) => {
  const rows = await buildRows(null);
  const TOP = 100;
  const top = rows.slice(0, TOP);
  // Surface the caller's own row + rank when they're below the visible cut —
  // lets the frontend show "Your rank: 137th" so users out of the top N still
  // know where they stand.
  let me: { rank: number; row: (typeof rows)[number] } | null = null;
  if (req.userId) {
    const idx = rows.findIndex((r) => r.userId === req.userId);
    if (idx >= TOP) {
      me = { rank: idx + 1, row: rows[idx] };
    }
  }
  res.json({ rows: top, me });
});

/**
 * Handles the GET /friends route or middleware callback.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Copies or reshapes arrays/objects into lookup maps, sets, or immutable derived values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 */
leaderboardRouter.get("/friends", requireAuth, async (req: AuthedRequest, res) => {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: FriendshipStatus.ACCEPTED,
      OR: [{ requesterId: req.userId! }, { addresseeId: req.userId! }],
    },
  });
  const friendIds = friendships.map((f) =>
    f.requesterId === req.userId ? f.addresseeId : f.requesterId,
  );
  const ids = [...friendIds, req.userId!];
  const rows = await buildRows(ids);
  res.json({ rows });
});
