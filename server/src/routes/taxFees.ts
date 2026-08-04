import { Router } from "express";
import { db } from "../db.js";
import { fastForwardPausedRule } from "../lib/recurringEngine.js";

export const taxFeesRouter = Router();

const SCHEDULES = ["Annually", "Quarterly", "Monthly", "Bi-Monthly", "Variable"];

taxFeesRouter.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, a.account_name AS debit_from_account_name, rr.id AS rule_id, rr.schedule, rr.template_amount_minor, rr.next_run_date, rr.reminder_lead_time_days
       FROM tax_fees t
       JOIN accounts a ON a.id = t.debit_from_account_id
       LEFT JOIN recurring_rules rr ON rr.tax_fee_id = t.id
       ORDER BY t.regulatory_name`
    )
    .all() as any[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      regulatoryName: r.regulatory_name,
      description: r.description,
      feeCategory: r.fee_category,
      debitFromAccountId: r.debit_from_account_id,
      debitFromAccountName: r.debit_from_account_name,
      status: r.status,
      recurringRuleId: r.rule_id,
      schedule: r.schedule,
      templateAmountMinor: r.template_amount_minor,
      nextRunDate: r.next_run_date,
      reminderLeadTimeDays: r.reminder_lead_time_days,
    }))
  );
});

taxFeesRouter.post("/", (req, res) => {
  const { regulatoryName, description, feeCategory, debitFromAccountId, schedule, templateAmountMinor, nextRunDate, reminderLeadTimeDays } =
    req.body as Record<string, any>;

  const errors: string[] = [];
  if (!regulatoryName || !String(regulatoryName).trim()) errors.push("Regulatory Name is required.");
  if (!debitFromAccountId) errors.push("Debit From account is required (needed for auto-drafted payments, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Fee Amount is required.");
  if (schedule !== "Variable" && !nextRunDate) errors.push("Next Run Date is required unless Schedule is Variable (2.7).");

  const account = debitFromAccountId ? (db.prepare("SELECT status FROM accounts WHERE id = ?").get(debitFromAccountId) as any) : null;
  if (debitFromAccountId && !account) errors.push("Debit From account not found.");
  if (account && account.status !== "Active") errors.push("Debit From account must be Active.");

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    const info = db
      .prepare(`INSERT INTO tax_fees (regulatory_name, description, fee_category, debit_from_account_id) VALUES (?, ?, ?, ?)`)
      .run(String(regulatoryName).trim(), description ?? null, feeCategory ?? null, debitFromAccountId);
    const feeId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO recurring_rules (tax_fee_id, schedule, template_amount_minor, next_run_date, reminder_lead_time_days)
       VALUES (?, ?, ?, ?, ?)`
    ).run(feeId, schedule, templateAmountMinor, schedule === "Variable" ? null : nextRunDate, reminderLeadTimeDays ?? null);

    db.exec("COMMIT");
    res.status(201).json({ id: feeId });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/tax-fees/:id — edit an existing tax/fee + its Recurring Rule.
// Mirrors utilities.ts's PATCH: same field set and validation as create,
// and Next Run Date is left alone here for the same reason (changing it
// retroactively would fight the missed-run catch-up logic, 2.7) — create a
// fresh tax/fee instead if the schedule itself needs to change.
taxFeesRouter.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM tax_fees WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Tax/fee not found."] });

  const { regulatoryName, description, feeCategory, debitFromAccountId, schedule, templateAmountMinor, reminderLeadTimeDays } =
    req.body as Record<string, any>;

  const errors: string[] = [];
  if (!regulatoryName || !String(regulatoryName).trim()) errors.push("Regulatory Name is required.");
  if (!debitFromAccountId) errors.push("Debit From account is required (needed for auto-drafted payments, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Fee Amount is required.");

  const account = debitFromAccountId ? (db.prepare("SELECT status FROM accounts WHERE id = ?").get(debitFromAccountId) as any) : null;
  if (debitFromAccountId && !account) errors.push("Debit From account not found.");
  if (account && account.status !== "Active") errors.push("Debit From account must be Active.");

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE tax_fees SET regulatory_name = ?, description = ?, fee_category = ?, debit_from_account_id = ? WHERE id = ?`
    ).run(String(regulatoryName).trim(), description ?? null, feeCategory ?? null, debitFromAccountId, req.params.id);
    db.prepare(
      `UPDATE recurring_rules SET schedule = ?, template_amount_minor = ?, reminder_lead_time_days = ?
       WHERE tax_fee_id = ?`
    ).run(schedule, templateAmountMinor, reminderLeadTimeDays ?? null, req.params.id);

    db.exec("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/tax-fees/:id/status — pause/resume, e.g. a fee that no longer
// applies. Mirrors utilities.ts's status endpoint: the recurring job stops
// drafting payments and it drops off Upcoming Dues, but history and the
// record itself stay intact for reactivation later.
taxFeesRouter.patch("/:id/status", (req, res) => {
  const { status } = req.body as { status?: string };
  if (status !== "Active" && status !== "Paused") return res.status(422).json({ errors: ["Status must be 'Active' or 'Paused'."] });

  const existing = db.prepare("SELECT id FROM tax_fees WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Tax/fee not found."] });

  db.prepare("UPDATE tax_fees SET status = ? WHERE id = ?").run(status, req.params.id);
  if (status === "Active") fastForwardPausedRule({ taxFeeId: Number(req.params.id) });

  res.json({ ok: true });
});
