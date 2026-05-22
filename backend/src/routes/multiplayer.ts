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

/**
 * Handles the POST /rooms route or middleware callback.
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
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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

/**
 * Handles the POST /join route or middleware callback.
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
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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

/**
 * Handles the GET /rooms/:code route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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

/**
 * Handles the POST /rooms/:code/start route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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

/**
 * Handles the POST /rooms/:code/leave route or middleware callback.
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
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
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
