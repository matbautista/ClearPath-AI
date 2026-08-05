import { Router } from "express";
import { db } from "../db.js";
import { INCOME_CATEGORIES } from "../lib/transactionRules.js";
import { fastForwardPausedRule } from "../lib/recurringEngine.js";

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
      status: r.status,
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

// PATCH /api/income-sources/:id — edit an existing income source + its
// Recurring Rule. Mirrors utilities.ts's PATCH: same field set and
// validation as create, and Next Run Date is left alone here for the same
// reason (changing it retroactively would fight the missed-run catch-up
// logic, 2.7) — create a fresh income source instead if the schedule itself
// needs to change.
incomeSourcesRouter.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT id FROM income_sources WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Income source not found."] });

  const { sourceName, description, incomeCategory, creditToAccountId, schedule, templateAmountMinor, reminderLeadTimeDays } =
    req.body as Record<string, any>;

  const errors: string[] = [];
  if (!sourceName || !String(sourceName).trim()) errors.push("Source Name is required.");
  if (!incomeCategory || !INCOME_CATEGORIES.includes(incomeCategory)) errors.push("Income Category must be valid.");
  if (!creditToAccountId) errors.push("Credit To account is required (needed for auto-drafted deposits, 2.7).");
  if (!schedule || !SCHEDULES.includes(schedule)) errors.push("Schedule must be one of: " + SCHEDULES.join(", "));
  if (!templateAmountMinor || templateAmountMinor <= 0) errors.push("Gross Amount is required.");

  const account = creditToAccountId ? (db.prepare("SELECT status FROM accounts WHERE id = ?").get(creditToAccountId) as any) : null;
  if (creditToAccountId && !account) errors.push("Credit To account not found.");
  if (account && account.status !== "Active") errors.push("Credit To account must be Active.");

  if (errors.length > 0) return res.status(422).json({ errors });

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE income_sources SET source_name = ?, description = ?, income_category = ?, credit_to_account_id = ? WHERE id = ?`
    ).run(String(sourceName).trim(), description ?? null, incomeCategory, creditToAccountId, req.params.id);
    db.prepare(
      `UPDATE recurring_rules SET schedule = ?, template_amount_minor = ?, reminder_lead_time_days = ?
       WHERE income_source_id = ?`
    ).run(schedule, templateAmountMinor, reminderLeadTimeDays ?? null, req.params.id);

    db.exec("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// PATCH /api/income-sources/:id/status — pause/resume, e.g. a contract or
// gig that ended. Mirrors utilities.ts's status endpoint: the recurring job
// stops drafting deposits, but history and the record itself stay intact
// for reactivation later. Unlike utilities/tax-fees, this has no effect on
// Upcoming Dues either way — Income Sources were never in that list to
// begin with (dashboardEngine.ts's computeUpcomingDues deliberately
// excludes income; the spec's list is "loans, cards, utilities, taxes,"
// not money coming in).
incomeSourcesRouter.patch("/:id/status", (req, res) => {
  const { status } = req.body as { status?: string };
  if (status !== "Active" && status !== "Paused") return res.status(422).json({ errors: ["Status must be 'Active' or 'Paused'."] });

  const existing = db.prepare("SELECT id FROM income_sources WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ errors: ["Income source not found."] });

  db.prepare("UPDATE income_sources SET status = ? WHERE id = ?").run(status, req.params.id);
  if (status === "Active") fastForwardPausedRule({ incomeSourceId: Number(req.params.id) });

  res.json({ ok: true });
});
