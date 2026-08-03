// Net Worth (3.1): the live "today" figure reads the same cached balance
// columns the rest of the app already uses (fast, consistent with the
// Accounts page). Historical reconstruction — needed only for back-filling
// snapshot gaps (missed-run handling) — replays transaction history from
// Beginning Balance instead, since no cache exists for a past date.
import { db } from "../db.js";
import { addDaysUTC, todayUTC } from "./dateMath.js";

interface AccountRow {
  id: number;
  account_type: string;
  status: string;
  beginning_balance_minor: number;
}

function isLiabilityType(accountType: string): boolean {
  return accountType === "Loan" || accountType === "CreditCard";
}

export function computeCurrentNetWorth(): { totalAssetsMinor: number; totalLiabilitiesMinor: number; netWorthMinor: number } {
  const rows = db
    .prepare("SELECT account_type, status, current_balance_minor, card_balance_minor FROM accounts")
    .all() as { account_type: string; status: string; current_balance_minor: number; card_balance_minor: number }[];

  let totalAssetsMinor = 0;
  let totalLiabilitiesMinor = 0;
  for (const r of rows) {
    const balance = r.account_type === "CreditCard" ? r.card_balance_minor : r.current_balance_minor;
    // Closed accounts count toward Net Worth only while their balance is
    // nonzero (2.1) — a closed card/loan that's still owed money doesn't
    // silently disappear just because it's closed.
    if (r.status === "Closed" && balance === 0) continue;
    if (isLiabilityType(r.account_type)) totalLiabilitiesMinor += balance;
    else totalAssetsMinor += balance;
  }
  return { totalAssetsMinor, totalLiabilitiesMinor, netWorthMinor: totalAssetsMinor - totalLiabilitiesMinor };
}

// Reconstructs one account's balance as of a given date (inclusive) by
// replaying Posted transaction history — the same ledger-amount and
// direction rules as the live posting engine (2.2), just computed as an
// aggregate instead of an incremental cache update.
export function computeBalanceAsOf(account: AccountRow, asOfDate: string): number {
  const isLiability = isLiabilityType(account.account_type);
  const splitType = account.account_type === "CreditCard" ? "CardPayment" : account.account_type === "Loan" ? "LoanPayment" : null;

  const rows = db
    .prepare(
      `SELECT indicator, amount_minor, additional_fees_minor, principal_portion_minor, txn_type
       FROM transactions
       WHERE source_account_id = ? AND status = 'Posted' AND txn_date <= ?`
    )
    .all(account.id, asOfDate) as { indicator: string; amount_minor: number; additional_fees_minor: number; principal_portion_minor: number | null; txn_type: string }[];

  let balance = account.beginning_balance_minor;
  for (const r of rows) {
    const ledgerAmt = splitType && r.txn_type === splitType ? r.principal_portion_minor! : r.amount_minor + r.additional_fees_minor;
    const sign = isLiability ? (r.indicator === "Debit" ? 1 : -1) : (r.indicator === "Credit" ? 1 : -1);
    balance += sign * ledgerAmt;
  }
  return balance;
}

export function computeNetWorthAsOf(asOfDate: string): { totalAssetsMinor: number; totalLiabilitiesMinor: number; netWorthMinor: number } {
  const accounts = db
    .prepare("SELECT id, account_type, status, beginning_balance_minor FROM accounts")
    .all() as unknown as AccountRow[];

  let totalAssetsMinor = 0;
  let totalLiabilitiesMinor = 0;
  for (const a of accounts) {
    const balance = computeBalanceAsOf(a, asOfDate);
    if (a.status === "Closed" && balance === 0) continue;
    if (isLiabilityType(a.account_type)) totalLiabilitiesMinor += balance;
    else totalAssetsMinor += balance;
  }
  return { totalAssetsMinor, totalLiabilitiesMinor, netWorthMinor: totalAssetsMinor - totalLiabilitiesMinor };
}

function takeSnapshotIfMissing(date: string): boolean {
  const exists = db.prepare("SELECT 1 FROM net_worth_snapshots WHERE snapshot_date = ?").get(date);
  if (exists) return false;
  const { totalAssetsMinor, totalLiabilitiesMinor, netWorthMinor } = computeNetWorthAsOf(date);
  db.prepare(
    "INSERT INTO net_worth_snapshots (snapshot_date, total_assets_minor, total_liabilities_minor, net_worth_minor) VALUES (?, ?, ?, ?)"
  ).run(date, totalAssetsMinor, totalLiabilitiesMinor, netWorthMinor);
  return true;
}

// Missed-run handling (3.1): back-fills every day between the last
// snapshot and today (inclusive) by reconstructing point-in-time
// balances, rather than leaving silent gaps in the trend chart when the
// self-hosted instance was offline at the scheduled time.
export function backfillSnapshots(today: string = todayUTC()): number {
  const last = db.prepare("SELECT MAX(snapshot_date) as d FROM net_worth_snapshots").get() as { d: string | null };
  let cursor = last.d ? addDaysUTC(last.d, 1) : today;

  let generated = 0;
  while (cursor <= today) {
    if (takeSnapshotIfMissing(cursor)) generated++;
    cursor = addDaysUTC(cursor, 1);
  }
  return generated;
}
