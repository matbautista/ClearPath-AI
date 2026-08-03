import { Router } from "express";
import { db } from "../db.js";
import { INCOME_CATEGORIES } from "../lib/transactionRules.js";

export const incomeSourcesRouter = Router();

const SCHEDULES = ["Annually", "Quarterly", "Monthly", "Bi-Monthly", "Variable"];

incomeSourcesRouter.get("/", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, a.account_name AS credit_to_account_name, rr.id AS rule_id, rr.schedule, rr.template_amount_minor, rr.next_run_date, rr.reminder_lead_time_days
       FROM income_sources i
       JOIN accounts a ON a.id = i.credit_to_account_id
       LEFT JOIN recurring_rules rr ON rr.income_source_id = i.id
       ORDER BY i.source_name`
    )
    .all() as any[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      sourceName: r.source_name,
      description: r.description,
      incomeCategory: r.income_category,
      creditToAccountId: r.credit_to_account_id,
      creditToAccountName: r.credit_to_account_name,
      recurringRuleId: r.rule_id,
      schedule: r.schedule,
      templateAmountMinor: r.template_amount_minor,
      nextRunDate: r.next_run_date,
      reminderLeadTimeDays: r.reminder_lead_time_days,
    }))
  );
});

incomeSourcesRouter.post("/", (req, res) => {
  const { sourceName, description, incomeCategory, creditToAccountId, schedule, templateAmountMinor, nextRunDate, reminderLeadTimeDays } =
    req.body as Record<string, any>;

  const errors: string[] = [];
  if (!sourceName || !String(sourceName).trim()) errors.push("Source Name is required.");
  if (!incomeCategory || !INCOME_CATEGORIES.includes(incomeCategory)) errors.push("Income Category must be valid.");
  if (!creditToAccountId) errors.push("Credit To account is required (needed for auto-drafted deposits, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Gross Amount is required.");
  if (schedule !== "Variable" && !nextRunDate) errors.push("Next Run Date is required unless Schedule is Variable (2.7).");

  const account = creditToAccountId ? (db.prepare("SELECT status FROM accounts WHERE id = ?").get(creditToAccountId) as any) : null;
  if (creditToAccountId && !account) errors.push("Credit To account not found.");
  if (account && account.status !== "Active") errors.push("Credit To account must be Active.");

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    const info = db
      .prepare(
        `INSERT INTO income_sources (source_name, description, income_category, credit_to_account_id) VALUES (?, ?, ?, ?)`
      )
      .run(String(sourceName).trim(), description ?? null, incomeCategory, creditToAccountId);
    const sourceId = Number(info.lastInsertRowid);

    db.prepare(
      `INSERT INTO recurring_rules (income_source_id, schedule, template_amount_minor, next_run_date, reminder_lead_time_days)
       VALUES (?, ?, ?, ?, ?)`
    ).run(sourceId, schedule, templateAmountMinor, schedule === "Variable" ? null : nextRunDate, reminderLeadTimeDays ?? null);

    db.exec("COMMIT");
    res.status(201).json({ id: sourceId });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});
