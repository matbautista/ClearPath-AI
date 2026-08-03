import { Router } from "express";
import { db } from "../db.js";

export const utilitiesRouter = Router();

const SCHEDULES = ["Annually", "Quarterly", "Monthly", "Bi-Monthly", "Variable"];

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

  const account = defaultAccountId ? (db.prepare("SELECT status FROM accounts WHERE id = ?").get(defaultAccountId) as any) : null;
  if (defaultAccountId && !account) errors.push("Default Account not found.");
  if (account && account.status !== "Active") errors.push("Default Account must be Active.");

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    const uInfo = db
      .prepare(
        `INSERT INTO utilities (provider_name, description, service_account_number, service_account_name, default_account_id, cut_off_date_day, due_date_day)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(providerName).trim(),
        description ?? null,
        serviceAccountNumber ?? null,
        serviceAccountName ?? null,
        defaultAccountId,
        cutOffDateDay ?? null,
        dueDateDay ?? null
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
