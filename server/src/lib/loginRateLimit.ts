// Per-IP login attempt throttling (4.3). Deliberately in-memory and
// simple, matching session.ts's "single-process, restart clears state"
// philosophy — this defends against sustained online brute-force of the
// passphrase, not a persistent audit/ban system. More exploitable now
// that start.bat defaults to LAN exposure (HOST=0.0.0.0, no TLS) than
// when this app was loopback-only, since anyone on the same Wi-Fi can
// now reach /api/settings/login directly (DEPLOY.md's "Access" section).
//
// Keyed by IP rather than one global counter so one noisy/attacking
// device can't lock out the legitimate user's own devices.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // failures older than this don't count toward a lockout
const LOCKOUT_MS = 15 * 60 * 1000; // how long a lockout lasts once triggered

interface Bucket {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function checkLoginRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true };

  if (bucket.lockedUntil !== null) {
    if (bucket.lockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    // Lockout has expired — give this key a clean slate rather than
    // resuming a half-full failure count.
    buckets.delete(key);
    return { allowed: true };
  }

  // Not locked, but a stale failure window (no failure in WINDOW_MS)
  // shouldn't count toward a future lockout either.
  if (now - bucket.lastFailureAt > WINDOW_MS) {
    buckets.delete(key);
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const existing = buckets.get(key);
  const bucket: Bucket =
    existing && now - existing.lastFailureAt <= WINDOW_MS
      ? existing
      : { failures: 0, lastFailureAt: now, lockedUntil: null };

  bucket.failures += 1;
  bucket.lastFailureAt = now;
  if (bucket.failures >= MAX_ATTEMPTS) {
    bucket.lockedUntil = now + LOCKOUT_MS;
  }
  buckets.set(key, bucket);
}

export function recordLoginSuccess(key: string): void {
  buckets.delete(key);
}
