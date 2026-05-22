import { Router } from "express";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  AuthedRequest,
  clearAuthCookie,
  requireAuth,
  setAuthCookie,
  signToken,
} from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit";

export const authRouter = Router();

/**
 * Handles the registered middleware callback.
 *
 * Parameters:
 * - `_req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 * - `next` (`NextFunction`): Express continuation callback for passing control to the next middleware.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
authRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  next();
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(40),
});

/**
 * Handles the POST /register route or middleware callback.
 *
 * Parameters:
 * - `req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.post("/register", authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;
  const displayName = parsed.data.displayName.trim();
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (existing) {
    res.status(409).json({ error: "email already registered" });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, displayName },
  });
  setAuthCookie(req, res, signToken(user.id));
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

/**
 * Handles the POST /login route or middleware callback.
 *
 * Parameters:
 * - `req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Validates unknown input with schema/runtime checks before using narrowed values.
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.post("/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  setAuthCookie(req, res, signToken(user.id));
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
});

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;

/**
 * Handles the POST /google route or middleware callback.
 *
 * Parameters:
 * - `req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `Promise<void>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.post("/google", authLimiter, async (req, res) => {
  if (!googleClient || !googleClientId) {
    res.status(503).json({ error: "google sso not configured" });
    return;
  }
  const credential = (req.body?.credential as string) || "";
  if (!credential) {
    res.status(400).json({ error: "missing credential" });
    return;
  }
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    res.status(401).json({ error: "invalid google token" });
    return;
  }
  if (!payload?.sub || !payload.email) {
    res.status(401).json({ error: "google token missing claims" });
    return;
  }

  let user = await prisma.user.findUnique({ where: { googleId: payload.sub } });
  const email = payload.email.trim().toLowerCase();
  if (!user) {
    user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId: payload.sub },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email,
          googleId: payload.sub,
          displayName: payload.name?.trim() || email.split("@")[0],
        },
      });
    }
  }
  setAuthCookie(req, res, signToken(user.id));
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName } });
});

/**
 * Handles the GET /config route or middleware callback.
 *
 * Parameters:
 * - `_req` (`Request<{}, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 */
authRouter.get("/config", (_req, res) => {
  res.json({ googleClientId: googleClientId || null });
});

/**
 * Handles the POST /logout route or middleware callback.
 *
 * Parameters:
 * - `req` (`Request<{}, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
authRouter.post("/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.json({ ok: true });
});

/**
 * Handles the GET /me route or middleware callback.
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
authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: {
      id: true,
      email: true,
      displayName: true,
      createdAt: true,
      googleId: true,
      passwordHash: true,
    },
  });
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.createdAt,
      // Boolean flags rather than the raw values — clients shouldn't see hashes.
      hasPassword: Boolean(user.passwordHash),
      hasGoogle: Boolean(user.googleId),
    },
  });
});

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(40),
});

/**
 * Handles the PATCH /me route or middleware callback.
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
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.patch("/me", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: { displayName: parsed.data.displayName.trim() },
    select: { id: true, email: true, displayName: true },
  });
  res.json({ user });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
});

/**
 * Handles the POST /change-password route or middleware callback.
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
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.post(
  "/change-password",
  authLimiter,
  requireAuth,
  async (req: AuthedRequest, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    // If the user already has a password, require the current one. If they're
    // a Google-only account adding a password for the first time, no current
    // password is required.
    if (user.passwordHash) {
      const currentPassword = parsed.data.currentPassword ?? "";
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) {
        res.status(401).json({ error: "current password is incorrect" });
        return;
      }
    }
    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
    await prisma.user.update({
      where: { id: req.userId! },
      data: { passwordHash },
    });
    res.json({ ok: true });
  },
);

const deleteAccountSchema = z.object({
  confirm: z.literal("DELETE"),
});

/**
 * Handles the DELETE /me route or middleware callback.
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
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
authRouter.delete("/me", requireAuth, async (req: AuthedRequest, res) => {
  // Defensive confirmation token in the body so a stray DELETE can't wipe
  // an account by mistake.
  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "must include confirm: \"DELETE\"" });
    return;
  }
  await prisma.user.delete({ where: { id: req.userId! } });
  res.json({ ok: true });
});
