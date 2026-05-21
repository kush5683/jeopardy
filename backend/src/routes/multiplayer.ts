import { Router } from "express";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import {
  createRoomSchema,
  joinRoomSchema,
  multiplayerService,
} from "../multiplayer/service";
import {
  multiplayerCreateLimiter,
  multiplayerJoinLimiter,
} from "../middleware/rateLimit";

export const multiplayerRouter = Router();

multiplayerRouter.post(
  "/rooms",
  multiplayerCreateLimiter,
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const room = await multiplayerService.createRoom({
        hostUserId: req.userId!,
        source: parsed.data.source,
        date: parsed.data.date,
      });
      res.json({ room });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "room creation failed" });
    }
  },
);

multiplayerRouter.post(
  "/join",
  multiplayerJoinLimiter,
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = joinRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const room = await multiplayerService.joinRoom(parsed.data.code, req.userId!);
      res.json({ room });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "join failed" });
    }
  },
);

multiplayerRouter.get(
  "/rooms/:code",
  requireAuth,
  async (req: AuthedRequest, res) => {
    try {
      const room = await multiplayerService.getRoom(req.params.code, req.userId!);
      res.json({ room });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "room lookup failed" });
    }
  },
);

multiplayerRouter.post(
  "/rooms/:code/start",
  requireAuth,
  async (req: AuthedRequest, res) => {
    try {
      const room = await multiplayerService.startRoom(req.params.code, req.userId!);
      res.json({ room });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "room start failed" });
    }
  },
);

multiplayerRouter.post(
  "/rooms/:code/leave",
  requireAuth,
  async (req: AuthedRequest, res) => {
    try {
      const room = await multiplayerService.leaveRoom(req.params.code, req.userId!);
      res.json({ room });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? "leave failed" });
    }
  },
);
