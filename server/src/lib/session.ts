// In-memory session store — deliberately simple for a single-user
// self-hosted instance. Sessions don't survive a server restart; the
// user just logs in again with their passphrase.
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export const SESSION_COOKIE = "clearpath_session";

// Two independent expirations (4.3 — the "sessions never expire" gap
// flagged during the app-baseline-v1 review): IDLE_TIMEOUT_MS logs out
// a session that's simply gone quiet (a stolen cookie left unused, a
// forgotten browser tab); ABSOLUTE_TTL_MS caps how long a session can
// live at all, even if kept "alive" by real or replayed traffic, so a
// leaked cookie doesn't grant indefinite access just because someone
// keeps using it. Values chosen for a personal finance app used across
// a normal day, not a high-security multi-tenant service — adjust here
// if that tradeoff is wrong for how this instance is actually used.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, regardless of activity

interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
}

const sessions = new Map<string, SessionRecord>();

export function createSession(): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(token, { createdAt: now, lastSeenAt: now });
  return token;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

// Single source of truth for "is this token still good" — validates
// both expirations and, on success, slides the idle window forward so
// an actively-used session doesn't get logged out mid-task.
export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  const record = sessions.get(token);
  if (!record) return false;

  const now = Date.now();
  if (now - record.createdAt > ABSOLUTE_TTL_MS || now - record.lastSeenAt > IDLE_TIMEOUT_MS) {
    sessions.delete(token);
    return false;
  }
  record.lastSeenAt = now;
  return true;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!isValidSession(token)) {
    return res.status(401).json({ errors: ["Not authenticated."] });
  }
  next();
}
