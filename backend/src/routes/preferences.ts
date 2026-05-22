import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

export const preferencesRouter = Router();

const META_CATEGORIES = new Set([
  "Geography",
  "US History",
  "World History",
  "Science",
  "Math",
  "Literature",
  "Wordplay",
  "Sports",
  "Entertainment",
  "Food & Drink",
  "Religion",
  "Other",
]);

const putSchema = z.object({
  disabledMetaCategories: z.array(z.string()),
});

/**
 * Handles the GET / route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
preferencesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { disabledMetaCategories: true },
  });
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({ disabledMetaCategories: user.disabledMetaCategories });
});

/**
 * Handles the PUT / route or middleware callback.
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
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
preferencesRouter.put("/", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  // Drop anything not in the known set so a future schema rename can't poison the DB.
  const clean = parsed.data.disabledMetaCategories.filter((m) =>
    META_CATEGORIES.has(m),
  );
  await prisma.user.update({
    where: { id: req.userId! },
    data: { disabledMetaCategories: clean },
  });
  res.json({ disabledMetaCategories: clean });
});
