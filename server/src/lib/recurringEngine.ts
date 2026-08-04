// The scheduled-job side of Recurring Rules (2.7): advancing Next Run
// Date, generating Pending Confirmation drafts (one per missed cycle —
// the missed-run catch-up rule, not a silent skip or a single batched
// draft), and confirming/skipping those drafts.
import { db } from "../db.js";
import { getAccount, applyBalanceDelta } from "./transactionEngine.js";
import { recomputeGoalsForAccount } from "./goalEngine.js";

export type Schedule = "Annually" | "Quarterly" | "Monthly" | "Bi-Monthly" | "Variable";

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

// Advances a YYYY-MM-DD date by one cycle, clamping the day-of-month to
// the target month's last day when it doesn't exist there (Jan 31
// Monthly -> Feb 28/29, never Feb 31) — the day-of-month clamping rule
// resolved during schema design (schema.sql). Known simplification: the
// clamped day becomes the new anchor for the next advance, so a rule
// that crosses February can permanently drift to day 28 afterward —
// acceptable for a first pass, worth revisiting if it matters in practice.
export function advanceCycle(dateStr: string, schedule: Schedule): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const monthsToAdd = schedule === "Monthly" ? 1 : schedule === "Bi-Monthly" ? 2 : schedule === "Quarterly" ? 3 : 12;
  const targetMonth0 = m - 1 + monthsToAdd;
  const targetYear = y + Math.floor(targetMonth0 / 12);
  const targetMonth0Norm = ((targetMonth0 % 12) + 12) % 12;
  const clampedDay = Math.min(d, daysInMonth(targetYear, targetMonth0Norm));
  const mm = String(targetMonth0Norm + 1).padStart(2, "0");
  const dd = String(clampedDay).padStart(2, "0");
  return `${targetYear}-${mm}-${dd}`;
}

interface RuleRow {
  id: number;
  utility_id: number | null;
  income_source_id: number | null;
  tax_fee_id: number | null;
  schedule: Schedule;
  template_amount_minor: number;
  next_run_date: string | null;
}

function resolveSourceForRule(rule: RuleRow): {
  accountId: number;
  txnType: "BillsPayment" | "IncomeReceived";
  spendingCategoryId: number | null;
  incomeCategory: string | null;
} {
  if (rule.utility_id) {
    const u = db.prepare("SELECT default_account_id FROM utilities WHERE id = ?").get(rule.utility_id) as { default_account_id: number };
    const cat = db.prepare("SELECT id FROM spending_categories WHERE name = 'Utilities'").get() as { id: number };
    return { accountId: u.default_account_id, txnType: "BillsPayment", spendingCategoryId: cat.id, incomeCategory: null };
  }
  if (rule.tax_fee_id) {
    const t = db.prepare("SELECT debit_from_account_id FROM tax_fees WHERE id = ?").get(rule.tax_fee_id) as { debit_from_account_id: number };
    const cat = db.prepare("SELECT id FROM spending_categories WHERE name = 'Taxes/Fees'").get() as { id: number };
    return { accountId: t.debit_from_account_id, txnType: "BillsPayment", spendingCategoryId: cat.id, incomeCategory: null };
  }
  const i = db
    .prepare("SELECT credit_to_account_id, income_category FROM income_sources WHERE id = ?")
    .get(rule.income_source_id!) as { credit_to_account_id: number; income_category: string };
  return { accountId: i.credit_to_account_id, txnType: "IncomeReceived", spendingCategoryId: null, incomeCategory: i.income_category };
}

// Creates one Pending Confirmation draft for one cycle — does NOT touch
// account balances (2.7: "Pending transactions don't affect account
// balances until the user confirms them").
function createDraft(rule: RuleRow, txnDate: string) {
  const { accountId, txnType, spendingCategoryId, incomeCategory } = resolveSourceForRule(rule);
  const indicator = txnType === "IncomeReceived" ? "Credit" : "Debit";
  const info = db
    .prepare(
      `INSERT INTO transactions (
         description, txn_date, amount_minor, additional_fees_minor, indicator,
         source_account_id, txn_type, spending_category_id, income_category, status
       ) VALUES (NULL, ?, ?, 0, ?, ?, ?, ?, ?, 'PendingConfirmation')`
    )
    .run(txnDate, rule.template_amount_minor, indicator, accountId, txnType, spendingCategoryId, incomeCategory);
  db.prepare("UPDATE recurring_rules SET last_generated_transaction_id = ? WHERE id = ?").run(info.lastInsertRowid, rule.id);
  return Number(info.lastInsertRowid);
}

export function runDueRecurringRules(today: string = new Date().toISOString().slice(0, 10)): number {
  // Paused utilities/income sources/tax fees (decommissioned subscriptions,
  // e.g. Amazon Prime; an ended income source; a fee no longer owed) are
  // excluded here rather than deleted — this both skips new drafts and
  // leaves next_run_date frozen where it was, so nothing to "catch up" on
  // once un-paused (see fastForwardPausedRule).
  const rules = db
    .prepare(
      `SELECT rr.* FROM recurring_rules rr
       LEFT JOIN utilities u ON u.id = rr.utility_id
       LEFT JOIN income_sources i ON i.id = rr.income_source_id
       LEFT JOIN tax_fees t ON t.id = rr.tax_fee_id
       WHERE rr.schedule != 'Variable' AND rr.next_run_date IS NOT NULL AND rr.next_run_date <= ?
         AND (u.id IS NULL OR u.status = 'Active')
         AND (i.id IS NULL OR i.status = 'Active')
         AND (t.id IS NULL OR t.status = 'Active')`
    )
    .all(today) as unknown as RuleRow[];

  let generated = 0;
  for (const rule of rules) {
    let nextRun = rule.next_run_date!;
    while (nextRun <= today) {
      createDraft(rule, nextRun);
      generated++;
      nextRun = advanceCycle(nextRun, rule.schedule);
    }
    db.prepare("UPDATE recurring_rules SET next_run_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextRun, rule.id);
  }
  return generated;
}

// Called when a utility/income source/tax fee comes off Pause. Its
// recurring_rules.next_run_date was frozen at whatever it was when paused
// (possibly months in the past) — advance it to the next real cycle >=
// today WITHOUT generating drafts for the paused span, since resuming
// shouldn't back-bill (or back-pay, for income sources).
export function fastForwardPausedRule(
  linkedTo: { utilityId: number } | { incomeSourceId: number } | { taxFeeId: number },
  today: string = new Date().toISOString().slice(0, 10)
) {
  const [column, id] =
    "utilityId" in linkedTo
      ? (["utility_id", linkedTo.utilityId] as const)
      : "incomeSourceId" in linkedTo
        ? (["income_source_id", linkedTo.incomeSourceId] as const)
        : (["tax_fee_id", linkedTo.taxFeeId] as const);

  const rule = db
    .prepare(`SELECT id, schedule, next_run_date FROM recurring_rules WHERE ${column} = ?`)
    .get(id) as { id: number; schedule: Schedule; next_run_date: string | null } | undefined;
  if (!rule || rule.schedule === "Variable" || !rule.next_run_date) return;

  let nextRun = rule.next_run_date;
  while (nextRun <= today) nextRun = advanceCycle(nextRun, rule.schedule);
  db.prepare("UPDATE recurring_rules SET next_run_date = ?, updated_at = datetime('now') WHERE id = ?").run(nextRun, rule.id);
}

export class PendingTransactionError extends Error {}

export function confirmPendingTransaction(transactionId: number, amountOverrideMinor?: number) {
  const txn = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId) as any;
  if (!txn) throw new PendingTransactionError("Transaction not found.");
  if (txn.status !== "PendingConfirmation") throw new PendingTransactionError("Only Pending Confirmation transactions can be confirmed.");

  const amount = amountOverrideMinor ?? txn.amount_minor;
  db.prepare("UPDATE transactions SET status = 'Posted', amount_minor = ?, updated_at = datetime('now') WHERE id = ?").run(
    amount,
    transactionId
  );

  const account = getAccount(txn.source_account_id)!;
  applyBalanceDelta(account, txn.indicator, amount);
  recomputeGoalsForAccount(account.id);
}

export function skipPendingTransaction(transactionId: number) {
  const txn = db.prepare("SELECT status FROM transactions WHERE id = ?").get(transactionId) as { status: string } | undefined;
  if (!txn) throw new PendingTransactionError("Transaction not found.");
  if (txn.status !== "PendingConfirmation") throw new PendingTransactionError("Only Pending Confirmation transactions can be skipped.");
  db.prepare("UPDATE transactions SET status = 'Voided', updated_at = datetime('now') WHERE id = ?").run(transactionId);
}
