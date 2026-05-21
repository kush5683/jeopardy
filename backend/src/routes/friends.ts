import { Router } from "express";
import { z } from "zod";
import { FriendshipStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { friendRequestLimiter } from "../middleware/rateLimit";

export const friendsRouter = Router();

friendsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: FriendshipStatus.ACCEPTED,
      OR: [{ requesterId: req.userId! }, { addresseeId: req.userId! }],
    },
    include: {
      requester: { select: { id: true, displayName: true } },
      addressee: { select: { id: true, displayName: true } },
    },
  });
  const friends = friendships.map((f) => {
    const other = f.requesterId === req.userId ? f.addressee : f.requester;
    return { ...other, friendshipId: f.id };
  });
  res.json({ friends });
});

friendsRouter.get("/pending", requireAuth, async (req: AuthedRequest, res) => {
  const incoming = await prisma.friendship.findMany({
    where: { addresseeId: req.userId!, status: FriendshipStatus.PENDING },
    include: {
      requester: { select: { id: true, displayName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const outgoing = await prisma.friendship.findMany({
    where: { requesterId: req.userId!, status: FriendshipStatus.PENDING },
    include: {
      addressee: { select: { id: true, displayName: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    incoming: incoming.map((f) => ({
      id: f.id,
      from: f.requester,
      createdAt: f.createdAt,
    })),
    outgoing: outgoing.map((f) => ({
      id: f.id,
      to: f.addressee,
      createdAt: f.createdAt,
    })),
  });
});

const requestSchema = z.object({ email: z.string().email() });

friendsRouter.post(
  "/request",
  friendRequestLimiter,
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    // Always respond with the same shape regardless of whether the target
    // exists, is self, or is already a friend — otherwise this endpoint is an
    // email-enumeration oracle. The legitimate-user UX is unchanged because the
    // recipient sees the incoming request in their pending list either way.
    const ok = { ok: true };
    const email = parsed.data.email.trim().toLowerCase();
    const target = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (!target || target.id === req.userId) {
      res.json(ok);
      return;
    }
    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: req.userId!, addresseeId: target.id },
          { requesterId: target.id, addresseeId: req.userId! },
        ],
      },
    });
    if (existing) {
      res.json(ok);
      return;
    }
    await prisma.friendship.create({
      data: {
        requesterId: req.userId!,
        addresseeId: target.id,
      },
    });
    res.json(ok);
  },
);

friendsRouter.post(
  "/respond/:id",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const id = req.params.id;
    const accept = req.body?.accept === true;
    const friendship = await prisma.friendship.findUnique({ where: { id } });
    if (!friendship || friendship.addresseeId !== req.userId) {
      res.status(404).json({ error: "request not found" });
      return;
    }
    if (friendship.status !== FriendshipStatus.PENDING) {
      res.status(400).json({ error: "already responded" });
      return;
    }
    if (accept) {
      const updated = await prisma.friendship.update({
        where: { id },
        data: {
          status: FriendshipStatus.ACCEPTED,
          respondedAt: new Date(),
        },
      });
      res.json({ friendship: updated });
    } else {
      await prisma.friendship.delete({ where: { id } });
      res.json({ deleted: true });
    }
  },
);

friendsRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const id = req.params.id;
  const friendship = await prisma.friendship.findUnique({ where: { id } });
  if (
    !friendship ||
    (friendship.requesterId !== req.userId &&
      friendship.addresseeId !== req.userId)
  ) {
    res.status(404).json({ error: "not found" });
    return;
  }
  await prisma.friendship.delete({ where: { id } });
  res.json({ deleted: true });
});
