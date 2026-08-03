// In-memory session store — deliberately simple for a single-user
// self-hosted instance. Sessions don't survive a server restart; the
// user just logs in again with their passphrase. Fast-follow candidate:
// persist to a table if that friction turns out to matter in practice.
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const SESSION_COOKIE = "clearpath_session";
const sessions = new Set<string>();

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  sessions.add(token);
  return token;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

export function isValidSession(token: string | undefined): boolean {
  return !!token && sessions.has(token);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!isValidSession(token)) {
    return res.status(401).json({ errors: ["Not authenticated."] });
  }
  next();
}
