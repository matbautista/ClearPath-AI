// Regression coverage for 0fc63d7 ("Prevent goals sharing an account from
// double-counting its balance"). Before that fix, each goal capped its own
// claim at the account's balance in isolation, so two goals linked to the
// same over-committed account could each count the same real money and
// both falsely flip to Completed.
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db.js";
import { computeGoalProgress } from "../goalEngine.js";

function insertAccount(name: string, balanceMinor: number): number {
  const result = db
    .prepare(`INSERT INTO accounts (account_type, account_name, current_balance_minor) VALUES ('Bank', ?, ?)`)
    .run(name, balanceMinor);
  return Number(result.lastInsertRowid);
}

function insertGoal(targetMinor: number): number {
  const result = db.prepare(`INSERT INTO goals (goal_type, target_amount_minor) VALUES ('SavingsTarget', ?)`).run(targetMinor);
  return Number(result.lastInsertRowid);
}

function linkAccount(goalId: number, accountId: number, allocationType: "FixedAmount" | "Percentage", allocationValue: number) {
  db.prepare(
    `INSERT INTO goal_account_links (goal_id, account_id, allocation_type, allocation_value) VALUES (?, ?, ?, ?)`
  ).run(goalId, accountId, allocationType, allocationValue);
}

beforeEach(() => {
  db.exec("DELETE FROM goal_account_links");
  db.exec("DELETE FROM goals");
  db.exec("DELETE FROM accounts");
});

describe("computeGoalProgress — over-committed shared accounts (0fc63d7)", () => {
  it("scales each goal's claim proportionally so shared claims never exceed the account's real balance", () => {
    const accountId = insertAccount("Shared Savings", 100_000); // PHP 1,000.00
    const goalA = insertGoal(100_000);
    const goalB = insertGoal(100_000);
    linkAccount(goalA, accountId, "Percentage", 100);
    linkAccount(goalB, accountId, "Percentage", 100);

    const progressA = computeGoalProgress(goalA)!;
    const progressB = computeGoalProgress(goalB)!;

    expect(progressA.currentAmountMinor).toBe(50_000);
    expect(progressB.currentAmountMinor).toBe(50_000);
    expect(progressA.currentAmountMinor + progressB.currentAmountMinor).toBe(100_000);
    expect(progressA.isComplete).toBe(false);
    expect(progressB.isComplete).toBe(false);
  });

  it("does not scale down a goal whose account isn't over-committed", () => {
    const accountId = insertAccount("Solo Savings", 100_000);
    const goal = insertGoal(80_000);
    linkAccount(goal, accountId, "Percentage", 100);

    const progress = computeGoalProgress(goal)!;
    expect(progress.currentAmountMinor).toBe(100_000);
    expect(progress.isComplete).toBe(true);
  });

  it("excludes Abandoned goals from the shared-claim total", () => {
    const accountId = insertAccount("Shared Savings 2", 100_000);
    const goalA = insertGoal(100_000);
    const goalB = insertGoal(100_000);
    linkAccount(goalA, accountId, "Percentage", 100);
    linkAccount(goalB, accountId, "Percentage", 100);
    db.prepare("UPDATE goals SET status = 'Abandoned' WHERE id = ?").run(goalB);

    const progressA = computeGoalProgress(goalA)!;
    expect(progressA.currentAmountMinor).toBe(100_000);
    expect(progressA.isComplete).toBe(true);
  });
});
