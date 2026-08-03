import { Router } from "express";
import { db } from "../db.js";
import { runDueRecurringRules, confirmPendingTransaction, skipPendingTransaction, PendingTransactionError } from "../lib/recurringEngine.js";

export const recurringRouter = Router();

recurringRouter.get("/pending", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, a.account_name AS source_account_name, sc.name AS spending_category_name
       FROM transactions t
       JOIN accounts a ON a.id = t.source_account_id
       LEFT JOIN spending_categories sc ON sc.id = t.spending_category_id
       WHERE t.status = 'PendingConfirmation'
       ORDER BY t.txn_date`
    )
    .all() as any[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      txnDate: r.txn_date,
      amountMinor: r.amount_minor,
      indicator: r.indicator,
      sourceAccountId: r.source_account_id,
      sourceAccountName: r.source_account_name,
      txnType: r.txn_type,
      spendingCategoryName: r.spending_category_name,
      incomeCategory: r.income_category,
    }))
  );
});

recurringRouter.post("/pending/:id/confirm", (req, res) => {
  const { amountMinor } = req.body as { amountMinor?: number };
  try {
    confirmPendingTransaction(Number(req.params.id), amountMinor);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PendingTransactionError) return res.status(422).json({ errors: [err.message] });
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

recurringRouter.post("/pending/:id/skip", (req, res) => {
  try {
    skipPendingTransaction(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PendingTransactionError) return res.status(422).json({ errors: [err.message] });
    res.status(500).json({ errors: [(err as Error).message] });
  }
});

// Manual trigger for dev/testing — in normal operation this runs on
// server startup and on a periodic interval (see index.ts), matching
// 2.7's missed-run catch-up behavior for a self-hosted instance that
// was offline past a Next Run Date.
recurringRouter.post("/run-due", (_req, res) => {
  const generated = runDueRecurringRules();
  res.json({ generated });
});
