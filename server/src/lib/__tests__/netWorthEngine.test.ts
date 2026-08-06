// Regression coverage for 097b270 ("Fix Net Worth trend chart freezing
// intraday"). Before the fix, takeSnapshotIfMissing wrote today's row once
// and every later call that day silently skipped it, so an account/
// transaction change after the first snapshot never showed up on the trend
// chart until midnight.
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db.js";
import { backfillSnapshots } from "../netWorthEngine.js";

const TODAY = "2026-08-06";

function insertAccount(balanceMinor: number): number {
  const result = db
    .prepare(`INSERT INTO accounts (account_type, account_name, current_balance_minor) VALUES ('Bank', 'Checking', ?)`)
    .run(balanceMinor);
  return Number(result.lastInsertRowid);
}

function snapshotFor(date: string): number | undefined {
  const row = db.prepare("SELECT net_worth_minor FROM net_worth_snapshots WHERE snapshot_date = ?").get(date) as
    | { net_worth_minor: number }
    | undefined;
  return row?.net_worth_minor;
}

beforeEach(() => {
  db.exec("DELETE FROM net_worth_snapshots");
  db.exec("DELETE FROM transactions");
  db.exec("DELETE FROM accounts");
});

describe("backfillSnapshots — today's row stays live intraday (097b270)", () => {
  it("refreshes today's snapshot on a second call after the balance changes, instead of freezing it", () => {
    const accountId = insertAccount(100_000);
    backfillSnapshots(TODAY);
    expect(snapshotFor(TODAY)).toBe(100_000);

    db.prepare("UPDATE accounts SET current_balance_minor = ? WHERE id = ?").run(150_000, accountId);
    backfillSnapshots(TODAY);
    expect(snapshotFor(TODAY)).toBe(150_000);
  });

  it("never re-touches a past day's snapshot once written, only today's", () => {
    db.prepare(
      "INSERT INTO net_worth_snapshots (snapshot_date, total_assets_minor, total_liabilities_minor, net_worth_minor) VALUES ('2026-08-05', 0, 0, 42)"
    ).run();
    insertAccount(100_000);

    backfillSnapshots(TODAY);

    expect(snapshotFor("2026-08-05")).toBe(42);
    expect(snapshotFor(TODAY)).toBe(100_000);
  });
});
