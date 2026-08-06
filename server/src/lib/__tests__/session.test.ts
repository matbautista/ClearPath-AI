// Regression coverage for ccde298 ("Expire sessions on idle timeout and
// absolute TTL"). Before this, sessions never expired once created, so a
// leaked or stolen cookie granted indefinite access.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSession, isValidSession } from "../session.js";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T09:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isValidSession — idle timeout and absolute TTL (ccde298)", () => {
  it("stays valid for a fresh session", () => {
    const token = createSession();
    expect(isValidSession(token)).toBe(true);
  });

  it("expires a session idle for longer than the idle timeout", () => {
    const token = createSession();
    vi.advanceTimersByTime(IDLE_TIMEOUT_MS + 1000);
    expect(isValidSession(token)).toBe(false);
  });

  it("stays valid across the idle window as long as it's used before each timeout", () => {
    const token = createSession();
    // Touch the session just under the idle window, several times in a
    // row — each touch should slide the idle window forward.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000);
      expect(isValidSession(token)).toBe(true);
    }
  });

  it("expires a repeatedly-used session once the absolute TTL is reached, even though it's never idle", () => {
    const token = createSession();
    // Keep sliding the idle window forward, but never let total elapsed
    // time cross the idle timeout on its own — only the absolute TTL
    // should eventually end this session.
    const step = IDLE_TIMEOUT_MS - 1000;
    let elapsed = 0;
    while (elapsed + step < ABSOLUTE_TTL_MS) {
      vi.advanceTimersByTime(step);
      elapsed += step;
      expect(isValidSession(token)).toBe(true);
    }
    vi.advanceTimersByTime(step);
    expect(isValidSession(token)).toBe(false);
  });

  it("treats a missing or unknown token as invalid", () => {
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("not-a-real-token")).toBe(false);
  });
});
