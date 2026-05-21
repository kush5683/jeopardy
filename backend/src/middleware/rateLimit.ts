import { Request } from "express";
import rateLimit from "express-rate-limit";

// We sit behind Cloudflare + an nginx reverse proxy, so req.ip would resolve to
// the proxy. Prefer CF-Connecting-IP (set by Cloudflare), then the first hop of
// X-Forwarded-For, then req.ip as a last resort. We don't enable `trust proxy`
// because that would also affect req.protocol / req.hostname, which we don't
// rely on but easily could in the future — the explicit key extractor is safer.
function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0]!.trim();
  }
  return req.ip ?? "unknown";
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
