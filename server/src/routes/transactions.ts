import { Router } from "express";
import { db } from "../db.js";
import { postTransaction, ValidationError, type PostTransactionInput } from "../lib/transactionEngine.js";
import { TXN_RULES, INCOME_CATEGORIES, type TxnType } from "../lib/transactionRules.js";

export const transactionsRouter = Router();

// GET /api/transactions/rules — lets the client build its Add Transaction
// form generically from the same rules the server enforces, instead of
// duplicating the leg/category/account-type logic in two places.
transactionsRouter.get("/rules", (_req, res) => {
  res.json({ rules: TXN_RULES, incomeCategories: INCOME_CATEGORIES });
});

transactionsRouter.get("/", (req, res) => {
  const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
  const rows = accountId
    ? db
        .prepare(
          `SELECT t.*, sc.name AS spending_category_name, a.account_name AS destination_account_name
           FROM transactions t
           LEFT JOIN spending_categories sc ON sc.id = t.spending_category_id
           LEFT JOIN accounts a ON a.id = t.destination_account_id
           WHERE t.source_account_id = ?
           ORDER BY t.txn_date DESC, t.id DESC
           LIMIT 200`
        )
        .all(accountId)
    : db
        .prepare(
          `SELECT t.*, sc.name AS spending_category_name, a.account_name AS destination_account_name
           FROM transactions t
           LEFT JOIN spending_categories sc ON sc.id = t.spending_category_id
           LEFT JOIN accounts a ON a.id = t.destination_account_id
           ORDER BY t.txn_date DESC, t.id DESC
           LIMIT 200`
        )
        .all();

  res.json(
    (rows as any[]).map((r) => ({
      id: r.id,
      description: r.description,
      txnDate: r.txn_date,
      amountMinor: r.amount_minor,
      additionalFeesMinor: r.additional_fees_minor,
      indicator: r.indicator,
      sourceAccountId: r.source_account_id,
      destinationAccountId: r.destination_account_id,
      destinationAccountName: r.destination_account_name,
      txnType: r.txn_type,
      spendingCategoryName: r.spending_category_name,
      incomeCategory: r.income_category,
      principalPortionMinor: r.principal_portion_minor,
      interestPortionMinor: r.interest_portion_minor,
      linkedTransactionId: r.linked_transaction_id,
      status: r.status,
    }))
  );
});

transactionsRouter.post("/", (req, res) => {
  const input = req.body as PostTransactionInput & { txnType: TxnType };
  try {
    const result = postTransaction(input);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(422).json({ errors: err.errors });
    res.status(500).json({ errors: [(err as Error).message] });
  }
});
