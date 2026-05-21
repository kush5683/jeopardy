import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthedRequest extends Request {
  userId?: string;
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET!, { expiresIn: "30d" });
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing token" });
    return;
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET!) as { sub: string };
    req.userId = decoded.sub;
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

export function optionalAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(header.slice(7), JWT_SECRET!) as {
        sub: string;
      };
      req.userId = decoded.sub;
    } catch {
      // ignore — treat as anonymous
    }
  }
  next();
}
