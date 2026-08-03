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
  res.json((rows as unknown as AccountRow[]).map(toApiShape));
});

accountsRouter.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as unknown as AccountRow | undefined;
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
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(info.lastInsertRowid) as unknown as AccountRow;
    res.status(201).json(toApiShape(row));
  } catch (err) {
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/accounts/:id — edit an existing account. Account Type and
// Beginning Balance are deliberately not editable here: Beginning Balance
// only seeds Current/Card Balance once at creation (2.1) and is never
// revisited afterward (transactionEngine.ts increments the balance columns
// in place per transaction, it doesn't re-derive them from Beginning
// Balance + history), so changing it later would desync the stored balance
// from its own transaction history. Changing Account Type would invalidate
// every transaction and TXN_RULES check (2.3) already posted against the
// original type. Status has no such hazard — closing an account has no
// balance-zero requirement (2.1) — so it's editable here alongside the
// same cosmetic/metadata fields exposed on create.
accountsRouter.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as unknown as AccountRow | undefined;
  if (!existing) return res.status(404).json({ errors: ["Account not found."] });

  const body = req.body as Partial<AccountInput> & { status?: string };
  const input: AccountInput = {
    accountType: existing.account_type as AccountInput["accountType"],
    accountName: body.accountName ?? existing.account_name,
    institutionName: body.institutionName,
    interestRatePct: body.interestRatePct,
    creditLimitMinor: body.creditLimitMinor,
    loanAmountMinor: body.loanAmountMinor,
  };

  const errors = validateAccountInput(input);
  const status = body.status ?? existing.status;
  if (status !== "Active" && status !== "Closed") errors.push("Status must be Active or Closed.");

  if (errors.length > 0) return res.status(422).json({ errors });

  try {
    db.prepare(
      `UPDATE accounts SET institution_name = @institutionName, account_name = @accountName,
         interest_rate_pct = @interestRatePct, credit_limit_minor = @creditLimitMinor,
         loan_amount_minor = @loanAmountMinor, status = @status, updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      institutionName: input.institutionName ?? null,
      accountName: input.accountName.trim(),
      interestRatePct: input.interestRatePct ?? null,
      creditLimitMinor: input.creditLimitMinor ?? null,
      loanAmountMinor: input.loanAmountMinor ?? null,
      status,
      id: req.params.id,
    });
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as unknown as AccountRow;
    res.json(toApiShape(row));
  } catch (err) {
    res.status(500).json({ errors: [(err as Error).message] });
  }
});
