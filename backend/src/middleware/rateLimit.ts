import { Request } from "express";
import rateLimit from "express-rate-limit";
import { requestIsLocalProxy } from "./auth";

// Only trust forwarding headers when the direct peer is a local/private proxy.
// If the app is ever exposed directly, a client should not be able to spoof
// CF-Connecting-IP / X-Forwarded-For and evade rate limits.
function clientIp(req: Request): string {
  if (requestIsLocalProxy(req)) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.length > 0) return cf;
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      return xff.split(",")[0]!.trim();
    }
  }
  return req.socket.remoteAddress ?? req.ip ?? "unknown";
}

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "too many auth attempts; try again in a minute" },
});

export const friendRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "too many friend requests; slow down" },
});

export const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // generous — one clue every ~0.5s — but bounds bot grinding.
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "rate limit exceeded" },
});

export const boardShareLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "too many board share requests; slow down" },
});

export const multiplayerCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "too many room creations; slow down" },
});

export const multiplayerJoinLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientIp,
  message: { error: "too many room join attempts; slow down" },
});
