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

function normalizeIp(value: string | undefined): string {
  if (!value) return "";
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function requestHost(req: Request): string {
  return (req.headers.host ?? "").toLowerCase();
}

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

function secureCookieEnabled(req: Request): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === "1") return true;
  if (override === "0") return false;
  return !isLocalHost(requestHost(req));
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookieEnabled(req),
    maxAge: SESSION_MAX_AGE_MS,
    path: SESSION_COOKIE_PATH,
  };
}

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

export function readAuthTokenFromHeaders(
  headers: Pick<IncomingHttpHeaders, "authorization" | "cookie">,
): string | null {
  const header = headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return readCookieHeader(headers.cookie, SESSION_COOKIE_NAME);
}

function tokenFromRequest(req: Request): string | null {
  return readAuthTokenFromHeaders(req.headers);
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET_VALUE, {
    expiresIn: "30d",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function setAuthCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(req));
}

export function clearAuthCookie(req: Request, res: Response): void {
  const opts = cookieOptions(req);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: opts.httpOnly,
    sameSite: opts.sameSite,
    secure: opts.secure,
    path: opts.path,
  });
}

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

export function verifyAuthToken(token: string): string {
  const decoded = jwt.verify(token, JWT_SECRET_VALUE, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  }) as { sub: string };
  return decoded.sub;
}

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
