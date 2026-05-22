import { IncomingHttpHeaders } from "http";
import { Request, Response, NextFunction, CookieOptions } from "express";
import jwt from "jsonwebtoken";

export interface AuthedRequest extends Request {
  userId?: string;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}
const JWT_SECRET_VALUE: string = JWT_SECRET;

const SESSION_COOKIE_NAME = "jeopardy_session";
const SESSION_COOKIE_PATH = "/api";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const JWT_ISSUER = "jeopardy-api";
const JWT_AUDIENCE = "jeopardy-web";

/**
 * Normalizes ip input.
 *
 * Parameters:
 * - `value` (`string | undefined`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function normalizeIp(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

/**
 * Implements the request host function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 */
function requestHost(req: Request): string {
  return (req.headers.host ?? "").toLowerCase();
}

/**
 * Checks the local host condition.
 *
 * Parameters:
 * - `host` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function isLocalHost(host: string): boolean {
  return (
    host.startsWith("localhost:") ||
    host === "localhost" ||
    host.startsWith("127.0.0.1:") ||
    host === "127.0.0.1" ||
    host.startsWith("[::1]:") ||
    host === "[::1]"
  );
}

/**
 * Implements the secure cookie enabled function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function secureCookieEnabled(req: Request): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1") return true;
  if (override === "0") return false;
  return !isLocalHost(requestHost(req));
}

/**
 * Implements the cookie options function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 *
 * Output:
 * - `CookieOptions`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookieEnabled(req),
    maxAge: SESSION_MAX_AGE_MS,
    path: SESSION_COOKIE_PATH,
  };
}

/**
 * Implements the read cookie header function.
 *
 * Parameters:
 * - `header` (`string | string[] | undefined`): Caller-provided value consumed by the function body.
 * - `name` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Normalizes strings by trimming, changing case, replacing characters, or canonicalizing text.
 * - Tokenizes or pattern-matches strings to derive comparable values.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
function readCookieHeader(
  header: string | string[] | undefined,
  name: string,
): string | null {
  if (!header) return null;
  const target = `${name}=`;
  const value = Array.isArray(header) ? header.join(";") : header;
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(target)) continue;
    const raw = trimmed.slice(target.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Implements the read auth token from headers function.
 *
 * Parameters:
 * - `headers` (`Pick<IncomingHttpHeaders, "authorization" | "cookie">`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export function readAuthTokenFromHeaders(
  headers: Pick<IncomingHttpHeaders, "authorization" | "cookie">,
): string | null {
  const header = headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return readCookieHeader(headers.cookie, SESSION_COOKIE_NAME);
}

/**
 * Implements the token from request function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 *
 * Output:
 * - `string | null`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
function tokenFromRequest(req: Request): string | null {
  return readAuthTokenFromHeaders(req.headers);
}

/**
 * Implements the sign token function.
 *
 * Parameters:
 * - `userId` (`string`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET_VALUE, {
    expiresIn: "30d",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

/**
 * Implements the set auth cookie function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response`): HTTP response writer used to set status codes, headers, and JSON payloads.
 * - `token` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export function setAuthCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(req));
}

/**
 * Clears auth cookie state or resources.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response`): HTTP response writer used to set status codes, headers, and JSON payloads.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export function clearAuthCookie(req: Request, res: Response): void {
  const opts = cookieOptions(req);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: opts.httpOnly,
    sameSite: opts.sameSite,
    secure: opts.secure,
    path: opts.path,
  });
}

/**
 * Implements the request is local proxy function.
 *
 * Parameters:
 * - `req` (`Request`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 *
 * Output:
 * - `boolean`: Boolean decision value derived from validation, comparison, or state checks.
 *
 * Data transformations:
 * - Tokenizes or pattern-matches strings to derive comparable values.
 */
export function requestIsLocalProxy(req: Request): boolean {
  if (process.env.TRUST_PROXY_HEADERS === "1") return true;
  if (process.env.TRUST_PROXY_HEADERS === "0") return false;
  const ip = normalizeIp(req.socket.remoteAddress ?? req.ip);
  return (
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}

/**
 * Implements the verify auth token function.
 *
 * Parameters:
 * - `token` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `string`: String value normalized or composed from the inputs.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export function verifyAuthToken(token: string): string {
  const decoded = jwt.verify(token, JWT_SECRET_VALUE, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  }) as { sub: string };
  return decoded.sub;
}

/**
 * Implements the require auth function.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `res` (`Response`): HTTP response writer used to set status codes, headers, and JSON payloads.
 * - `next` (`NextFunction`): Express continuation callback for passing control to the next middleware.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Deserializes or serializes JSON for storage, API responses, or network boundaries.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const token = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }
  try {
    req.userId = verifyAuthToken(token);
    next();
  } catch {
    clearAuthCookie(req, res);
    res.status(401).json({ error: "invalid token" });
  }
}

/**
 * Implements the optional auth function.
 *
 * Parameters:
 * - `req` (`AuthedRequest`): HTTP request input carrying route params, query values, body data, cookies, and auth context as applicable.
 * - `_res` (`Response`): Caller-provided value consumed by the function body.
 * - `next` (`NextFunction`): Express continuation callback for passing control to the next middleware.
 *
 * Output:
 * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
 *
 * Data transformations:
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 * - Converts invalid states or failed operations into thrown errors or HTTP error responses.
 */
export function optionalAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token = tokenFromRequest(req);
  if (token) {
    try {
      req.userId = verifyAuthToken(token);
    } catch {
      // ignore — treat as anonymous
    }
  }
  next();
}
