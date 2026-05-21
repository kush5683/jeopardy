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

authRouter.get("/config", (_req, res) => {
  res.json({ googleClientId: googleClientId || null });
});

authRouter.post("/logout", (req, res) => {
  clearAuthCookie(req, res);
  res.json({ ok: true });
});

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
