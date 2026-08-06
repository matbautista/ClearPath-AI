// Regression coverage for b6ab8d3's fee-attribution fix. Before it, a
// transfer's Additional Fees were never counted as an expense: the
// transfer's own excluded category (Internal Transfer / Savings-Investment
// Transfer) silently swallowed its fee too, since the fee lived on the
// same row. Additional Fees must always count toward Taxes/Fees expense
// regardless of the transaction's own category (spec 2.5). dashboardEngine,
// moneyPitEngine, and aiAnalysisEngine all had the same duplicated query
// and were fixed together — this file exercises computeSavingsRate as the
// representative case.
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../db.js";
import { computeSavingsRate } from "../dashboardEngine.js";

function categoryId(name: string): number {
  return (db.prepare("SELECT id FROM spending_categories WHERE name = ?").get(name) as { id: number }).id;
}

function insertAccount(name: string): number {
  const result = db.prepare(`INSERT INTO accounts (account_type, account_name) VALUES ('Bank', ?)`).run(name);
  return Number(result.lastInsertRowid);
}

function insertDebit(opts: { accountId: number; amountMinor: number; feeMinor: number; categoryId: number; txnType: string }) {
  db.prepare(
    `INSERT INTO transactions
       (description, txn_date, amount_minor, additional_fees_minor, indicator, source_account_id, txn_type, spending_category_id, status)
     VALUES ('test txn', '2026-08-05', ?, ?, 'Debit', ?, ?, ?, 'Posted')`
  ).run(opts.amountMinor, opts.feeMinor, opts.accountId, opts.txnType, opts.categoryId);
}

beforeEach(() => {
  db.exec("DELETE FROM transactions");
  db.exec("DELETE FROM accounts");
});

describe("computeSavingsRate — transfer fee attribution (b6ab8d3)", () => {
  it("counts a transfer's Additional Fees as expense even though the transfer's own category is excluded", () => {
    const accountId = insertAccount("Checking");
    insertDebit({ accountId, amountMinor: 50_000, feeMinor: 1_000, categoryId: categoryId("Internal Transfer"), txnType: "eCashTransfer" });

    const { expenseMinor } = computeSavingsRate("2026-08-01", "2026-08-31");

    expect(expenseMinor).toBe(1_000);
  });

  it("still excludes a fee-free transfer's principal from expense entirely", () => {
    const accountId = insertAccount("Checking 2");
    insertDebit({ accountId, amountMinor: 50_000, feeMinor: 0, categoryId: categoryId("Internal Transfer"), txnType: "eCashTransfer" });

    const { expenseMinor } = computeSavingsRate("2026-08-01", "2026-08-31");

    expect(expenseMinor).toBe(0);
  });

  it("adds a real spending category's fee on top of its own amount, not in place of it", () => {
    const accountId = insertAccount("Checking 3");
    insertDebit({ accountId, amountMinor: 20_000, feeMinor: 500, categoryId: categoryId("Groceries"), txnType: "CardPurchase" });

    const { expenseMinor } = computeSavingsRate("2026-08-01", "2026-08-31");

    expect(expenseMinor).toBe(20_500);
  });
});
