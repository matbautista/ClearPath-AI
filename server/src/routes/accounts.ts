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

// Whether any transaction has ever posted against this account — the
// PATCH handler below uses this to decide whether Beginning Balance is
// still safely correctable (see its comment for why).
function accountHasTransactions(accountId: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM transactions WHERE source_account_id = ?").get(accountId) as {
    cnt: number;
  };
  return row.cnt > 0;
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
    hasTransactions: accountHasTransactions(row.id),
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

// PATCH /api/accounts/:id — edit an existing account. Account Type is
// never editable here: changing it would invalidate every transaction and
// TXN_RULES check (2.3) already posted against the original type. Status
// has no such hazard — closing an account has no balance-zero requirement
// (2.1) — so it's editable alongside the same cosmetic/metadata fields
// exposed on create.
//
// Beginning Balance is a narrower case: normally it's creation-only,
// because it only seeds Current/Card Balance once (2.1) and is never
// revisited afterward — transactionEngine.ts increments the balance
// columns in place per transaction rather than re-deriving them from
// Beginning Balance + history, so editing it once transactions exist would
// desync the stored balance from its own history. But if zero transactions
// have ever posted against the account, that hazard doesn't apply yet —
// Current/Card Balance still exactly equals Beginning Balance — so a
// correction is safe and re-seeds both the same way POST does.
accountsRouter.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as unknown as AccountRow | undefined;
  if (!existing) return res.status(404).json({ errors: ["Account not found."] });

  const body = req.body as Partial<AccountInput> & { status?: string };
  // reminderLeadTimeDays/valuationMethod fall back to the existing stored
  // value rather than clearing (unlike the other fields below, which the
  // client always resends in full on every edit) — neither has an edit
  // form field yet, so treating "not sent" as "clear it" would silently
  // wipe them on every unrelated edit (e.g. just flipping Status).
  const input: AccountInput = {
    accountType: existing.account_type as AccountInput["accountType"],
    accountName: body.accountName ?? existing.account_name,
    institutionName: body.institutionName,
    interestRatePct: body.interestRatePct,
    creditLimitMinor: body.creditLimitMinor,
    loanAmountMinor: body.loanAmountMinor,
    beginningBalanceMinor: body.beginningBalanceMinor,
    minimumPaymentMinor: body.minimumPaymentMinor,
    dueDateDay: body.dueDateDay,
    cutOffDateDay: body.cutOffDateDay,
    reminderLeadTimeDays: body.reminderLeadTimeDays !== undefined ? body.reminderLeadTimeDays : existing.reminder_lead_time_days,
    valuationMethod:
      body.valuationMethod !== undefined ? body.valuationMethod : (existing.valuation_method as AccountInput["valuationMethod"]),
  };

  const errors = validateAccountInput(input);
  const status = body.status ?? existing.status;
  if (status !== "Active" && status !== "Closed") errors.push("Status must be Active or Closed.");

  const isBalanceEdit = body.beginningBalanceMinor !== undefined && body.beginningBalanceMinor !== existing.beginning_balance_minor;
  if (isBalanceEdit && accountHasTransactions(existing.id)) {
    errors.push(
      "Beginning Balance can't be corrected anymore — this account already has posted transactions, so its balance is built from that history, not from Beginning Balance. Record a correcting transaction instead."
    );
  }

  if (errors.length > 0) return res.status(422).json({ errors });

  const isCreditCard = existing.account_type === "CreditCard";
  // current_balance_minor/card_balance_minor are only ever recomputed here
  // when isBalanceEdit is true (which validation above already guarantees
  // means zero transactions exist) — otherwise they're written back
  // unchanged, since they may hold real accumulated history that a Status
  // or Credit Limit edit on this same request must not disturb.
  const beginningBalanceMinor = isBalanceEdit ? input.beginningBalanceMinor! : existing.beginning_balance_minor;
  const currentBalanceMinor = isBalanceEdit ? (isCreditCard ? 0 : beginningBalanceMinor) : existing.current_balance_minor;
  const cardBalanceMinor = isBalanceEdit ? (isCreditCard ? beginningBalanceMinor : 0) : existing.card_balance_minor;

  try {
    db.prepare(
      `UPDATE accounts SET institution_name = @institutionName, account_name = @accountName,
         interest_rate_pct = @interestRatePct, credit_limit_minor = @creditLimitMinor,
         loan_amount_minor = @loanAmountMinor, status = @status,
         beginning_balance_minor = @beginningBalanceMinor,
         current_balance_minor = @currentBalanceMinor, card_balance_minor = @cardBalanceMinor,
         minimum_payment_minor = @minimumPaymentMinor, due_date_day = @dueDateDay,
         cut_off_date_day = @cutOffDateDay, reminder_lead_time_days = @reminderLeadTimeDays,
         valuation_method = @valuationMethod,
         updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      institutionName: input.institutionName ?? null,
      accountName: input.accountName.trim(),
      interestRatePct: input.interestRatePct ?? null,
      creditLimitMinor: input.creditLimitMinor ?? null,
      loanAmountMinor: input.loanAmountMinor ?? null,
      status,
      beginningBalanceMinor,
      currentBalanceMinor,
      cardBalanceMinor,
      minimumPaymentMinor: input.minimumPaymentMinor ?? null,
      dueDateDay: input.dueDateDay ?? null,
      cutOffDateDay: input.cutOffDateDay ?? null,
      reminderLeadTimeDays: input.reminderLeadTimeDays ?? null,
      valuationMethod: input.valuationMethod ?? null,
      id: req.params.id,
    });
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(req.params.id) as unknown as AccountRow;
    res.json(toApiShape(row));
  } catch (err) {
    res.status(500).json({ errors: [(err as Error).message] });
  }
});
