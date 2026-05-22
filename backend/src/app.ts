import express from "express";
import path from "path";
import fs from "fs";
import { authRouter } from "./routes/auth";
import { cluesRouter } from "./routes/clues";
import { buzzerRouter } from "./routes/buzzer";
import { flashcardsRouter } from "./routes/flashcards";
import { friendsRouter } from "./routes/friends";
import { leaderboardRouter } from "./routes/leaderboard";
import { statsRouter } from "./routes/stats";
import { dailyRouter } from "./routes/daily";
import { reviewRouter } from "./routes/review";
import { preferencesRouter } from "./routes/preferences";
import { multiplayerRouter } from "./routes/multiplayer";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Implements the host is local function.
 *
 * Parameters:
 * - `host` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 */
function hostIsLocal(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.startsWith("localhost:") ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.0.0.1:") ||
    normalized === "[::1]" ||
    normalized.startsWith("[::1]:")
  );
}

/**
 * Implements the header origin host function.
 *
 * Parameters:
 * - `value` (`string | undefined`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function headerOriginHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Implements the content security policy function.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 */
function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self' https://accounts.google.com/gsi/client https://apis.google.com",
    "connect-src 'self' https://accounts.google.com https://*.google.com https://*.googleapis.com https://*.gstatic.com",
    "frame-src 'self' https://accounts.google.com https://*.google.com",
  ].join("; ");
}

/**
 * Builds app data.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Express`: Configured Express application instance.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Transforms collections with map/filter/reduce/sort/search operations.
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Updates application/browser state, cookies, or persistent browser storage from computed values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  /**
   * Handles the registered middleware callback.
   *
   * Parameters:
   * - `req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
   * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
   * - `next` (`NextFunction`): Express continuation callback for passing control to the next middleware.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  app.use((req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    res.setHeader("Content-Security-Policy", contentSecurityPolicy());
    // OAuth / SSO popup flows need to retain a usable opener relationship so
    // the popup can post its result back to the app window.
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Origin-Agent-Cluster", "?1");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (host && !hostIsLocal(host)) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=15552000; includeSubDomains",
      );
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  /**
   * Handles the registered middleware callback.
   *
   * Parameters:
   * - `req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
   * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
   * - `next` (`NextFunction`): Express continuation callback for passing control to the next middleware.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
   */
  app.use((req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const host = (req.headers.host ?? "").toLowerCase();
    if (!host) {
      res.status(400).json({ error: "missing host header" });
      return;
    }
    const originHost =
      headerOriginHost(
        typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      ) ??
      headerOriginHost(
        typeof req.headers.referer === "string"
          ? req.headers.referer
          : undefined,
      );
    if (originHost && originHost !== host) {
      res.status(403).json({ error: "cross-site request blocked" });
      return;
    }
    next();
  });

  /**
   * Handles the GET /api/health route or middleware callback.
   *
   * Parameters:
   * - `_req` (`Request<{}, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
   * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
   *
   * Output:
   * - `Response<any, Record<string, any>, number>`: Express response object returned by the chained response writer.
   *
   * Data transformations:
   * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
   */
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/clues", cluesRouter);
  app.use("/api/buzzer", buzzerRouter);
  app.use("/api/flashcards", flashcardsRouter);
  app.use("/api/friends", friendsRouter);
  app.use("/api/leaderboard", leaderboardRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/daily", dailyRouter);
  app.use("/api/review", reviewRouter);
  app.use("/api/preferences", preferencesRouter);
  app.use("/api/multiplayer", multiplayerRouter);

  // Serve frontend static files. In production (Dockerfile) frontend is copied to /app/public.
  // In dev (running from src), it's at ../../frontend/dist.
  const candidatePaths = [
    path.resolve(__dirname, "../public"),
    path.resolve(__dirname, "../../frontend/dist"),
  ];
  const frontendDist = candidatePaths.find((p) => fs.existsSync(p));
  if (frontendDist) {
    app.use(express.static(frontendDist));
    /**
     * Handles the GET registered route or middleware callback.
     *
     * Parameters:
     * - `_req` (`Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>`): Caller-provided value consumed by the function body.
     * - `res` (`Response<any, Record<string, any>, number>`): HTTP response writer used to set status codes, headers, and JSON payloads.
     *
     * Output:
     * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
     *
     * Data transformations:
     * - Tokenizes or pattern-matches strings to derive comparable values.
     */
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  return app;
}
