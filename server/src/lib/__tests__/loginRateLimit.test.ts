// Regression coverage for a88c841 ("Add per-IP login rate limiting").
// Before this, POST /api/settings/login had no attempt throttling beyond
// scrypt's inherent per-guess cost, more exploitable once start.bat
// defaults to LAN exposure.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkLoginRateLimit, recordLoginFailure, recordLoginSuccess } from "../loginRateLimit.js";

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("login rate limiting (a88c841)", () => {
  it("allows an IP with no recorded failures", () => {
    expect(checkLoginRateLimit("1.1.1.1")).toEqual({ allowed: true });
  });

  it("stays allowed through 4 failures, then locks out on the 5th", () => {
    const key = "10.0.0.2";
    for (let i = 0; i < 4; i++) {
      recordLoginFailure(key);
      expect(checkLoginRateLimit(key)).toEqual({ allowed: true });
    }
    recordLoginFailure(key);
    const result = checkLoginRateLimit(key);
    expect(result.allowed).toBe(false);
  });

  it("reports a retryAfterSeconds close to the full lockout window right after locking", () => {
    const key = "10.0.0.3";
    for (let i = 0; i < 5; i++) recordLoginFailure(key);
    const result = checkLoginRateLimit(key);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.retryAfterSeconds).toBeLessThanOrEqual(LOCKOUT_MS / 1000);
    }
  });

  it("unlocks and gives a clean slate once the lockout expires", () => {
    const key = "10.0.0.4";
    for (let i = 0; i < 5; i++) recordLoginFailure(key);
    expect(checkLoginRateLimit(key).allowed).toBe(false);

    vi.advanceTimersByTime(LOCKOUT_MS + 1000);
    expect(checkLoginRateLimit(key)).toEqual({ allowed: true });

    // Clean slate: locking out again should take another 5 failures, not
    // pick up where the old (expired) count left off.
    for (let i = 0; i < 4; i++) recordLoginFailure(key);
    expect(checkLoginRateLimit(key).allowed).toBe(true);
  });

  it("keeps one IP's lockout from affecting another IP", () => {
    const attacker = "10.0.0.5";
    const legitimateUser = "10.0.0.6";
    for (let i = 0; i < 5; i++) recordLoginFailure(attacker);

    expect(checkLoginRateLimit(attacker).allowed).toBe(false);
    expect(checkLoginRateLimit(legitimateUser)).toEqual({ allowed: true });
  });

  it("clears the failure count on a successful login", () => {
    const key = "10.0.0.7";
    for (let i = 0; i < 4; i++) recordLoginFailure(key);
    recordLoginSuccess(key);

    // Another 4 failures right after a success shouldn't trip the
    // lockout — the successful login should have reset the counter, not
    // left it at 4/5.
    for (let i = 0; i < 4; i++) recordLoginFailure(key);
    expect(checkLoginRateLimit(key).allowed).toBe(true);
  });

  it("doesn't count failures older than the rolling window toward a lockout", () => {
    const key = "10.0.0.8";
    for (let i = 0; i < 4; i++) recordLoginFailure(key);

    vi.advanceTimersByTime(WINDOW_MS + 1000);

    // This failure is outside the window from the first four, so it
    // should start a fresh count (1/5), not become the 5th and lock out.
    recordLoginFailure(key);
    expect(checkLoginRateLimit(key).allowed).toBe(true);
  });
});
