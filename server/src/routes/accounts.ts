import { Router } from "express";
import { db } from "../db.js";
import { validateAccountInput, type AccountInput } from "../lib/accountValidation.js";

export const accountsRouter = Router();

interface AccountRow {
  id: number;
  account_type: string;
  institution_name: string | null;
  description: string | null;
  account_name: string;
  beginning_balance_minor: number;
  current_balance_minor: number;
  card_balance_minor: number;
  interest_rate_pct: number | null;
  valuation_method: string | null;
  minimum_payment_minor: number | null;
  credit_limit_minor: number | null;
  loan_amount_minor: number | null;
  loan_term_months: number | null;
  due_date_day: number | null;
  cut_off_date_day: number | null;
  reminder_lead_time_days: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// Maps a DB row to the API shape — computes Available Balance on read
// per 2.1/2.4b ("derived, not stored": Credit Limit - Card Balance).
function toApiShape(row: AccountRow) {
  return {
    id: row.id,
    accountType: row.account_type,
    institutionName: row.institution_name,
    description: row.description,
    accountName: row.account_name,
    beginningBalanceMinor: row.beginning_balance_minor,
    currentBalanceMinor: row.account_type === "CreditCard" ? null : row.current_balance_minor,
    cardBalanceMinor: row.account_type === "CreditCard" ? row.card_balance_minor : null,
    availableBalanceMinor:
      row.account_type === "CreditCard" && row.credit_limit_minor != null
        ? row.credit_limit_minor - row.card_balance_minor
        : null,
    interestRatePct: row.interest_rate_pct,
    valuationMethod: row.valuation_method,
    minimumPaymentMinor: row.minimum_payment_minor,
    creditLimitMinor: row.credit_limit_minor,
    loanAmountMinor: row.loan_amount_minor,
    loanTermMonths: row.loan_term_months,
    dueDateDay: row.due_date_day,
    cutOffDateDay: row.cut_off_date_day,
    reminderLeadTimeDays: row.reminder_lead_time_days,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/accounts?status=Active|Closed  (default: all)
accountsRouter.get("/", (req, res) => {
  const status = req.query.status as string | undefined;
  const rows =
    status === "Active" || status === "Closed"
      ? db.prepare("SELECT * FROM accounts WHERE status = ? ORDER BY account_type, account_name").all(status)
      : db.prepare("SELECT * FROM accounts ORDER BY account_type, account_name").all();
  res.json((rows as AccountRow[]).map(toApiShape));
});

accountsRouter.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as AccountRow | undefined;
  if (!row) return res.status(404).json({ errors: ["Account not found."] });
  res.json(toApiShape(row));
});

// POST /api/accounts — create. Current/Card Balance are seeded from
// Beginning Balance at creation (2.1) since no transaction history exists
// yet; from then on they're maintained by the transactions API.
accountsRouter.post("/", (req, res) => {
  const input = req.body as AccountInput;
  const errors = validateAccountInput(input);
  if (errors.length > 0) return res.status(422).json({ errors });

  const beginningBalanceMinor = input.beginningBalanceMinor ?? 0;
  const isCreditCard = input.accountType === "CreditCard";

  try {
    const stmt = db.prepare(`
      INSERT INTO accounts (
        account_type, institution_name, description, account_name,
        beginning_balance_minor, current_balance_minor, card_balance_minor,
        interest_rate_pct, valuation_method, minimum_payment_minor,
        credit_limit_minor, loan_amount_minor, loan_term_months,
        due_date_day, cut_off_date_day, reminder_lead_time_days
      ) VALUES (
        @accountType, @institutionName, @description, @accountName,
        @beginningBalanceMinor, @currentBalanceMinor, @cardBalanceMinor,
        @interestRatePct, @valuationMethod, @minimumPaymentMinor,
        @creditLimitMinor, @loanAmountMinor, @loanTermMonths,
        @dueDateDay, @cutOffDateDay, @reminderLeadTimeDays
      )
    `);
    const info = stmt.run({
      accountType: input.accountType,
      institutionName: input.institutionName ?? null,
      description: input.description ?? null,
      accountName: input.accountName.trim(),
      beginningBalanceMinor,
      currentBalanceMinor: isCreditCard ? 0 : beginningBalanceMinor,
      cardBalanceMinor: isCreditCard ? beginningBalanceMinor : 0,
      interestRatePct: input.interestRatePct ?? null,
      valuationMethod: input.accountType === "Investment" ? (input.valuationMethod ?? "CostBasis") : null,
      minimumPaymentMinor: input.minimumPaymentMinor ?? null,
      creditLimitMinor: input.creditLimitMinor ?? null,
      loanAmountMinor: input.loanAmountMinor ?? null,
      loanTermMonths: input.loanTermMonths ?? null,
      dueDateDay: input.dueDateDay ?? null,
      cutOffDateDay: input.cutOffDateDay ?? null,
      reminderLeadTimeDays: input.reminderLeadTimeDays ?? null,
    });
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(info.lastInsertRowid) as AccountRow;
    res.status(201).json(toApiShape(row));
  } catch (err) {
    res.status(500).json({ errors: [(err as Error).message] });
  }
});
