// Posts a Transaction per the Double-Entry Rule (2.5) and field semantics
// (2.2): single-leg types write one row; two-leg types write two
// independent, linked rows (2.2's "two-leg transactions are two rows,
// not one row with two account fields") inside one DB transaction, then
// update each affected account's cached balance (2.1's "derived, not
// cached" rule — this cache is maintained here, the transactions table
// stays the source of truth; see schema.sql's recomputation query).
import { db } from "../db.js";
import { TXN_RULES, type TxnType, type AccountType } from "./transactionRules.js";

export interface PostTransactionInput {
  txnType: TxnType;
  txnDate: string;
  description?: string | null;
  amountMinor: number;
  additionalFeesMinor?: number;
  sourceAccountId: number;
  destinationAccountId?: number; // required for two-leg types
  spendingCategoryId?: number; // required when categoryKind === 'spending' and overridable, or to confirm the fixed default
  incomeCategory?: string; // required when categoryKind === 'income'
  principalPortionMinor?: number; // required when requiresPrincipalInterestSplit
  interestPortionMinor?: number;
}

interface AccountRow {
  id: number;
  account_type: AccountType;
  status: string;
}

function getAccount(id: number): AccountRow | undefined {
  return db.prepare("SELECT id, account_type, status FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

function getCategoryIdByName(name: string): number {
  const row = db.prepare("SELECT id FROM spending_categories WHERE name = ?").get(name) as { id: number } | undefined;
  if (!row) throw new ValidationError([`Spending category "${name}" is missing from the database.`]);
  return row.id;
}

export class ValidationError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(" "));
  }
}

// The balance-affecting amount for a given leg. Loan/CreditCard legs of a
// Payment (2.2, 2.4a) move only by the Principal Portion; every other leg
// moves by Amount + that leg's own Additional Fees (2.5's fee rule — fees
// are debited from the source leg only, so a destination leg's fee is 0).
function ledgerAmount(opts: {
  accountType: AccountType;
  amountMinor: number;
  additionalFeesMinor: number;
  principalPortionMinor?: number;
  requiresSplit: boolean;
}): number {
  if (opts.requiresSplit && (opts.accountType === "Loan" || opts.accountType === "CreditCard")) {
    return opts.principalPortionMinor!;
  }
  return opts.amountMinor + opts.additionalFeesMinor;
}

function applyBalanceDelta(account: AccountRow, indicator: "Debit" | "Credit", ledgerAmt: number) {
  const isLiability = account.account_type === "Loan" || account.account_type === "CreditCard";
  // Assets: Credit = balance up, Debit = balance down.
  // Liabilities: Debit = amount owed up, Credit = amount owed down.
  const sign = isLiability ? (indicator === "Debit" ? 1 : -1) : (indicator === "Credit" ? 1 : -1);
  const column = account.account_type === "CreditCard" ? "card_balance_minor" : "current_balance_minor";
  db.prepare(`UPDATE accounts SET ${column} = ${column} + ?, updated_at = datetime('now') WHERE id = ?`).run(
    sign * ledgerAmt,
    account.id
  );
}

export function postTransaction(input: PostTransactionInput) {
  const rule = TXN_RULES[input.txnType];
  if (!rule) throw new ValidationError([`Unknown transaction type "${input.txnType}".`]);

  const errors: string[] = [];
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    errors.push("Amount must be a positive whole number of minor units.");
  }
  const additionalFeesMinor = input.additionalFeesMinor ?? 0;
  if (!Number.isInteger(additionalFeesMinor) || additionalFeesMinor < 0) {
    errors.push("Additional Fees must be a non-negative whole number of minor units.");
  }

  const sourceAccount = getAccount(input.sourceAccountId);
  if (!sourceAccount) errors.push("Source account not found.");
  else if (sourceAccount.status !== "Active") errors.push("Source account is closed and cannot accept new transactions (2.1).");

  if (rule.legs === "single") {
    if (sourceAccount && !rule.accountTypes.includes(sourceAccount.account_type)) {
      errors.push(`${input.txnType} requires a ${rule.accountTypes.join("/")} account, not ${sourceAccount.account_type}.`);
    }
    if (rule.categoryKind === "spending" && !input.spendingCategoryId) {
      errors.push("Spending Category is required.");
    }
    if (rule.categoryKind === "income" && !input.incomeCategory) {
      errors.push("Income Category is required.");
    }
  } else {
    const destAccount = input.destinationAccountId != null ? getAccount(input.destinationAccountId) : undefined;
    if (!destAccount) errors.push("Destination account not found.");
    else if (destAccount.status !== "Active") errors.push("Destination account is closed and cannot accept new transactions (2.1).");

    if (sourceAccount && !rule.sourceAccountTypes.includes(sourceAccount.account_type)) {
      errors.push(`${input.txnType}'s source must be a ${rule.sourceAccountTypes.join("/")} account, not ${sourceAccount.account_type}.`);
    }
    if (destAccount && !rule.destAccountTypes.includes(destAccount.account_type)) {
      errors.push(`${input.txnType}'s destination must be a ${rule.destAccountTypes.join("/")} account, not ${destAccount.account_type}.`);
    }
    if (rule.requiresPrincipalInterestSplit) {
      if (!Number.isInteger(input.principalPortionMinor) || input.principalPortionMinor! < 0) {
        errors.push("Principal Portion is required.");
      }
      if (!Number.isInteger(input.interestPortionMinor) || input.interestPortionMinor! < 0) {
        errors.push("Interest Portion is required.");
      }
      if (
        Number.isInteger(input.principalPortionMinor) &&
        Number.isInteger(input.interestPortionMinor) &&
        input.principalPortionMinor! + input.interestPortionMinor! !== input.amountMinor
      ) {
        errors.push("Principal Portion + Interest Portion must equal Amount (2.2).");
      }
    }
    if (rule.categoryKind === "spending" && rule.categoryOverridable && !input.spendingCategoryId) {
      errors.push("Spending Category is required.");
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);

  db.exec("BEGIN");
  try {
    if (rule.legs === "single") {
      const spendingCategoryId = rule.categoryKind === "spending" ? input.spendingCategoryId : null;
      const incomeCategory = rule.categoryKind === "income" ? input.incomeCategory : null;

      const info = db
        .prepare(
          `INSERT INTO transactions (
             description, txn_date, amount_minor, additional_fees_minor, indicator,
             source_account_id, txn_type, spending_category_id, income_category, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Posted')`
        )
        .run(
          input.description ?? null,
          input.txnDate,
          input.amountMinor,
          additionalFeesMinor,
          rule.indicator,
          input.sourceAccountId,
          input.txnType,
          spendingCategoryId ?? null,
          incomeCategory ?? null
        );

      applyBalanceDelta(
        sourceAccount!,
        rule.indicator,
        ledgerAmount({
          accountType: sourceAccount!.account_type,
          amountMinor: input.amountMinor,
          additionalFeesMinor,
          requiresSplit: false,
        })
      );

      db.exec("COMMIT");
      return { id: Number(info.lastInsertRowid), linkedTransactionId: null };
    }

    // Two-leg: resolve category once, applied identically to both rows.
    let spendingCategoryId: number | null = null;
    if (rule.categoryKind === "spending") {
      spendingCategoryId = rule.categoryOverridable
        ? input.spendingCategoryId!
        : getCategoryIdByName(rule.defaultCategoryName!);
    }

    const sourceInfo = db
      .prepare(
        `INSERT INTO transactions (
           description, txn_date, amount_minor, additional_fees_minor, indicator,
           source_account_id, destination_account_id, txn_type, spending_category_id,
           principal_portion_minor, interest_portion_minor, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Posted')`
      )
      .run(
        input.description ?? null,
        input.txnDate,
        input.amountMinor,
        additionalFeesMinor,
        rule.sourceIndicator,
        input.sourceAccountId,
        input.destinationAccountId!,
        input.txnType,
        spendingCategoryId,
        rule.requiresPrincipalInterestSplit ? input.principalPortionMinor! : null,
        rule.requiresPrincipalInterestSplit ? input.interestPortionMinor! : null
      );
    const sourceLegId = Number(sourceInfo.lastInsertRowid);

    const destInfo = db
      .prepare(
        `INSERT INTO transactions (
           description, txn_date, amount_minor, additional_fees_minor, indicator,
           source_account_id, destination_account_id, txn_type, spending_category_id,
           principal_portion_minor, interest_portion_minor, linked_transaction_id, status
         ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'Posted')`
      )
      .run(
        input.description ?? null,
        input.txnDate,
        input.amountMinor, // destination never carries the fee (2.5)
        rule.destIndicator,
        input.destinationAccountId!,
        input.sourceAccountId,
        input.txnType,
        spendingCategoryId,
        rule.requiresPrincipalInterestSplit ? input.principalPortionMinor! : null,
        rule.requiresPrincipalInterestSplit ? input.interestPortionMinor! : null,
        sourceLegId
      );
    const destLegId = Number(destInfo.lastInsertRowid);

    db.prepare("UPDATE transactions SET linked_transaction_id = ? WHERE id = ?").run(destLegId, sourceLegId);

    const destAccount = getAccount(input.destinationAccountId!)!;
    applyBalanceDelta(
      sourceAccount!,
      rule.sourceIndicator,
      ledgerAmount({
        accountType: sourceAccount!.account_type,
        amountMinor: input.amountMinor,
        additionalFeesMinor,
        principalPortionMinor: input.principalPortionMinor,
        requiresSplit: rule.requiresPrincipalInterestSplit,
      })
    );
    applyBalanceDelta(
      destAccount,
      rule.destIndicator,
      ledgerAmount({
        accountType: destAccount.account_type,
        amountMinor: input.amountMinor,
        additionalFeesMinor: 0,
        principalPortionMinor: input.principalPortionMinor,
        requiresSplit: rule.requiresPrincipalInterestSplit,
      })
    );

    db.exec("COMMIT");
    return { id: sourceLegId, linkedTransactionId: destLegId };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
