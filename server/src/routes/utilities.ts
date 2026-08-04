import { Router } from "express";
import { db } from "../db.js";
import { TXN_RULES } from "../lib/transactionRules.js";
import { fastForwardPausedRule } from "../lib/recurringEngine.js";

export const utilitiesRouter = Router();

const SCHEDULES = ["Annually", "Quarterly", "Monthly", "Bi-Monthly", "Variable"];
// Utility payments always auto-draft as a BillsPayment transaction (see
// recurringEngine.ts) — a Default Account outside BillsPayment's allowed
// types would pass this validation but then fail every time the
// recurring job tries to actually post the payment. Reads the allowed
// list from TXN_RULES directly so it can't drift out of sync.
const BILLS_PAYMENT_ACCOUNT_TYPES = TXN_RULES.BillsPayment.legs === "single" ? TXN_RULES.BillsPayment.accountTypes : [];

utilitiesRouter.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.*, a.account_name AS default_account_name, rr.id AS rule_id, rr.schedule, rr.template_amount_minor, rr.next_run_date, rr.reminder_lead_time_days
       FROM utilities u
       JOIN accounts a ON a.id = u.default_account_id
       LEFT JOIN recurring_rules rr ON rr.utility_id = u.id
       ORDER BY u.provider_name`
    )
    .all() as any[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      providerName: r.provider_name,
      description: r.description,
      serviceAccountNumber: r.service_account_number,
      serviceAccountName: r.service_account_name,
      defaultAccountId: r.default_account_id,
      defaultAccountName: r.default_account_name,
      cutOffDateDay: r.cut_off_date_day,
      dueDateDay: r.due_date_day,
      policyType: r.policy_type,
      status: r.status,
      recurringRuleId: r.rule_id,
      schedule: r.schedule,
      templateAmountMinor: r.template_amount_minor,
      nextRunDate: r.next_run_date,
      reminderLeadTimeDays: r.reminder_lead_time_days,
    }))
  );
});

utilitiesRouter.post("/", (req, res) => {
  const {
    providerName,
    description,
    serviceAccountNumber,
    serviceAccountName,
    defaultAccountId,
    cutOffDateDay,
    dueDateDay,
    policyType,
    schedule,
    templateAmountMinor,
    nextRunDate,
    reminderLeadTimeDays,
  } = req.body as Record<string, any>;

  const errors: string[] = [];
  if (!providerName || !String(providerName).trim()) errors.push("Provider Name is required.");
  if (!defaultAccountId) errors.push("Default Account is required (needed for auto-drafted payments, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Template Amount is required.");
  if (schedule !== "Variable" && !nextRunDate) errors.push("Next Run Date is required unless Schedule is Variable (2.7).");
  if (cutOffDateDay != null && (cutOffDateDay < 1 || cutOffDateDay > 31)) errors.push("Cut-off Date must be between 1 and 31.");
  if (dueDateDay != null && (dueDateDay < 1 || dueDateDay > 31)) errors.push("Due Date must be between 1 and 31.");

  const account = defaultAccountId ? (db.prepare("SELECT status, account_type FROM accounts WHERE id = ?").get(defaultAccountId) as any) : null;
  if (defaultAccountId && !account) errors.push("Default Account not found.");
  if (account && account.status !== "Active") errors.push("Default Account must be Active.");
  if (account && !BILLS_PAYMENT_ACCOUNT_TYPES.includes(account.account_type)) {
    errors.push(
      `Default Account must be ${BILLS_PAYMENT_ACCOUNT_TYPES.join("/")} — utility payments auto-draft as a Bills Payment, which doesn't support ${account.account_type} (paying a bill from a credit card is a Card Purchase, a different transaction type not wired into recurring bills).`
    );
  }

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    const uInfo = db
      .prepare(
        `INSERT INTO utilities (provider_name, description, service_account_number, service_account_name, default_account_id, cut_off_date_day, due_date_day, policy_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(providerName).trim(),
        description ?? null,
        serviceAccountNumber ?? null,
        serviceAccountName ?? null,
        defaultAccountId,
        cutOffDateDay ?? null,
        dueDateDay ?? null,
        policyType && String(policyType).trim() ? String(policyType).trim() : null
      );
    const utilityId = Number(uInfo.lastInsertRowid);

    db.prepare(
      `INSERT INTO recurring_rules (utility_id, schedule, template_amount_minor, next_run_date, reminder_lead_time_days)
       VALUES (?, ?, ?, ?, ?)`
    ).run(utilityId, schedule, templateAmountMinor, schedule === "Variable" ? null : nextRunDate, reminderLeadTimeDays ?? null);

    db.exec("COMMIT");
    res.status(201).json({ id: utilityId });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/utilities/:id — edit an existing utility + its Recurring
// Rule. Not part of the original spec (3.7 only listed set-up, payment,
// listing, and recurring generation), but a real-world need: a bill's
// payment method or amount changes over time. Reuses the same field set
// and validation as create; only next_run_date is intentionally left
// alone here — changing it retroactively would fight the missed-run
// catch-up logic (2.7), so schedule changes should be handled by
// creating a fresh utility instead.
utilitiesRouter.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM utilities WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Utility not found."] });

  const {
    providerName,
    description,
    serviceAccountNumber,
    serviceAccountName,
    defaultAccountId,
    cutOffDateDay,
    dueDateDay,
    policyType,
    schedule,
    templateAmountMinor,
    reminderLeadTimeDays,
  } = req.body as Record<string, any>;

  const errors: string[] = [];
  if (!providerName || !String(providerName).trim()) errors.push("Provider Name is required.");
  if (!defaultAccountId) errors.push("Default Account is required (needed for auto-drafted payments, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Template Amount is required.");
  if (cutOffDateDay != null && (cutOffDateDay < 1 || cutOffDateDay > 31)) errors.push("Cut-off Date must be between 1 and 31.");
  if (dueDateDay != null && (dueDateDay < 1 || dueDateDay > 31)) errors.push("Due Date must be between 1 and 31.");

  const account = defaultAccountId ? (db.prepare("SELECT status, account_type FROM accounts WHERE id = ?").get(defaultAccountId) as any) : null;
  if (defaultAccountId && !account) errors.push("Default Account not found.");
  if (account && account.status !== "Active") errors.push("Default Account must be Active.");
  if (account && !BILLS_PAYMENT_ACCOUNT_TYPES.includes(account.account_type)) {
    errors.push(
      `Default Account must be ${BILLS_PAYMENT_ACCOUNT_TYPES.join("/")} — utility payments auto-draft as a Bills Payment, which doesn't support ${account.account_type} (paying a bill from a credit card is a Card Purchase, a different transaction type not wired into recurring bills).`
    );
  }

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE utilities SET provider_name = ?, description = ?, service_account_number = ?, service_account_name = ?,
         default_account_id = ?, cut_off_date_day = ?, due_date_day = ?, policy_type = ?
       WHERE id = ?`
    ).run(
      String(providerName).trim(),
      description ?? null,
      serviceAccountNumber ?? null,
      serviceAccountName ?? null,
      defaultAccountId,
      cutOffDateDay ?? null,
      dueDateDay ?? null,
      policyType && String(policyType).trim() ? String(policyType).trim() : null,
      req.params.id
    );
    db.prepare(
      `UPDATE recurring_rules SET schedule = ?, template_amount_minor = ?, reminder_lead_time_days = ?
       WHERE utility_id = ?`
    ).run(schedule, templateAmountMinor, reminderLeadTimeDays ?? null, req.params.id);

    db.exec("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/utilities/:id/status — pause/resume, e.g. a cancelled
// subscription (Amazon Prime). Paused: the recurring job stops drafting
// payments and it drops off Upcoming Dues, but the utility and its full
// transaction history stay intact for reactivation later — unlike delete,
// which doesn't exist here on purpose (see utility_id having no ON DELETE
// CASCADE from recurring_rules; a hard delete was never wired up).
utilitiesRouter.patch("/:id/status", (req, res) => {
  const { status } = req.body as { status?: string };
  if (status !== "Active" && status !== "Paused") return res.status(422).json({ errors: ["Status must be 'Active' or 'Paused'."] });

  const existing = db.prepare("SELECT id FROM utilities WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Utility not found."] });

  db.prepare("UPDATE utilities SET status = ? WHERE id = ?").run(status, req.params.id);
  if (status === "Active") fastForwardPausedRule({ utilityId: Number(req.params.id) });

  res.json({ ok: true });
});
