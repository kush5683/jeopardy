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
