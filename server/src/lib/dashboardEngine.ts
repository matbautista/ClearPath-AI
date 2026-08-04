import { db } from "../db.js";
import { advanceCycle } from "./recurringEngine.js";
import { addDaysUTC, todayUTC } from "./dateMath.js";

// Per-type Dashboard totals (3.1) — active accounts only, unlike Net
// Worth which also counts closed accounts with a nonzero balance.
export function computeAccountTypeTotals(): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT account_type, SUM(CASE WHEN account_type = 'CreditCard' THEN card_balance_minor ELSE current_balance_minor END) as total
       FROM accounts WHERE status = 'Active' GROUP BY account_type`
    )
    .all() as { account_type: string; total: number }[];
  const totals: Record<string, number> = { Cash: 0, Bank: 0, EWallet: 0, Investment: 0, Loan: 0, CreditCard: 0, RealEstate: 0 };
  for (const r of rows) totals[r.account_type] = r.total;
  return totals;
}

// Savings Rate (3.1): (Income total - Expense total) / Income total.
// Expense total reuses the exact category-total computation Category
// Trend Detection (3.11a) would use — excludes Internal Transfer and
// Savings/Investment Transfer, counts only the Interest Portion of debt
// payments, and (since each two-leg pair shares one category on both
// rows) sums the Debit leg only — see schema.sql's reference query,
// which this is a direct implementation of.
export function computeSavingsRate(startDate: string, endDate: string): { incomeMinor: number; expenseMinor: number; rate: number | null } {
  const income = db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) as total FROM transactions
       WHERE status = 'Posted' AND indicator = 'Credit'
         AND txn_type IN ('IncomeReceived', 'DividendInterestReceived')
         AND txn_date BETWEEN ? AND ?`
    )
    .get(startDate, endDate) as { total: number };

  const expense = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN txn_type IN ('LoanPayment','CardPayment') THEN interest_portion_minor ELSE amount_minor END
       ), 0) as total
       FROM transactions
       WHERE status = 'Posted' AND indicator = 'Debit' AND txn_date BETWEEN ? AND ?
         AND spending_category_id IS NOT NULL
         AND spending_category_id NOT IN (
           SELECT id FROM spending_categories WHERE name IN ('Internal Transfer', 'Savings/Investment Transfer')
         )`
    )
    .get(startDate, endDate) as { total: number };

  const incomeMinor = income.total;
  const expenseMinor = expense.total;
  const rate = incomeMinor === 0 ? null : (incomeMinor - expenseMinor) / incomeMinor;
  return { incomeMinor, expenseMinor, rate };
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

// Projects a recurring day-of-month (Loan/Credit Card Due Date, 2.1) to
// its next occurrence on or after `today`, clamping short months the
// same way advanceCycle does.
function nextOccurrenceOfDay(day: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  const clampedThisMonth = Math.min(day, daysInMonth(y, m - 1));
  const thisMonthDate = `${y}-${String(m).padStart(2, "0")}-${String(clampedThisMonth).padStart(2, "0")}`;
  if (thisMonthDate >= today) return thisMonthDate;
  return advanceCycle(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, "Monthly");
}

export interface UpcomingDue {
  label: string;
  dueDate: string;
  amountMinor: number;
  source: "Loan" | "CreditCard" | "Utility" | "TaxFee";
}

// Upcoming dues (3.1): merges Loan/Credit Card Account Due Date +
// Minimum Payment with Utility/Tax Recurring Rule Next Run Date +
// Template Amount into one sorted list. Income Sources are deliberately
// excluded — the spec's list is "loans, cards, utilities, taxes," not
// income, since money coming in isn't something you owe. A closed
// Loan/Credit Card still appears while its balance is nonzero (2.1).
export function computeUpcomingDues(withinDays = 30): UpcomingDue[] {
  const today = todayUTC();
  const horizonStr = addDaysUTC(today, withinDays);

  const dues: UpcomingDue[] = [];

  // Loans and Credit Cards are treated differently at zero balance: a Loan
  // that hits 0 is paid off for good (loans don't replenish), so it drops
  // out here regardless of status — nothing will ever be due on it again.
  // A Credit Card at 0 is just between statement cycles and can pick up
  // new charges before its next due date, so it stays in as long as it's
  // Active; the balance check on Credit Card only exists to still surface
  // a Closed card that somehow still owes money.
  const debtAccounts = db
    .prepare(
      `SELECT account_name, account_type, status, current_balance_minor, card_balance_minor, due_date_day, minimum_payment_minor
       FROM accounts
       WHERE account_type IN ('Loan', 'CreditCard') AND due_date_day IS NOT NULL
         AND (
           (account_type = 'CreditCard' AND (status = 'Active' OR card_balance_minor != 0))
           OR (account_type = 'Loan' AND current_balance_minor != 0)
         )`
    )
    .all() as any[];
  for (const a of debtAccounts) {
    const dueDate = nextOccurrenceOfDay(a.due_date_day, today);
    if (dueDate <= horizonStr) {
      dues.push({
        label: a.account_name,
        dueDate,
        amountMinor: a.minimum_payment_minor ?? 0,
        source: a.account_type,
      });
    }
  }

  const utilityRules = db
    .prepare(
      `SELECT u.provider_name as label, rr.next_run_date, rr.template_amount_minor
       FROM recurring_rules rr JOIN utilities u ON u.id = rr.utility_id
       WHERE rr.next_run_date IS NOT NULL AND rr.next_run_date <= ? AND u.status = 'Active'`
    )
    .all(horizonStr) as any[];
  for (const r of utilityRules) dues.push({ label: r.label, dueDate: r.next_run_date, amountMinor: r.template_amount_minor, source: "Utility" });

  const taxRules = db
    .prepare(
      `SELECT t.regulatory_name as label, rr.next_run_date, rr.template_amount_minor
       FROM recurring_rules rr JOIN tax_fees t ON t.id = rr.tax_fee_id
       WHERE rr.next_run_date IS NOT NULL AND rr.next_run_date <= ? AND t.status = 'Active'`
    )
    .all(horizonStr) as any[];
  for (const r of taxRules) dues.push({ label: r.label, dueDate: r.next_run_date, amountMinor: r.template_amount_minor, source: "TaxFee" });

  return dues.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
