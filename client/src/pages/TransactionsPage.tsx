import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Transaction, type TransactionRule, type SpendingCategory } from "../api";
import { formatMinor, toMinorUnits } from "../lib/money";
import { useSettings } from "../SettingsContext";
import type { Account } from "../types";

const TXN_TYPE_LABELS: Record<string, string> = {
  BillsPayment: "Bills Payment",
  CashPayment: "Cash Payment",
  CashDeposit: "Cash Deposit",
  CheckDeposit: "Check Deposit",
  CashWithdrawal: "Cash Withdrawal",
  eCashTransfer: "eCash Transfer",
  eCashPayment: "eCash Payment",
  CardPurchase: "Card Purchase",
  CardPayment: "Card Payment",
  LoanDisbursement: "Loan Disbursement",
  LoanPayment: "Loan Payment",
  InvestmentBuy: "Investment Buy",
  InvestmentSell: "Investment Sell",
  DividendInterestReceived: "Dividend/Interest Received",
  IncomeReceived: "Income Received",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TransactionsPage() {
  const { baseCurrency } = useSettings();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<SpendingCategory[]>([]);
  const [rules, setRules] = useState<Record<string, TransactionRule>>({});
  const [incomeCategories, setIncomeCategories] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());

  const [txnType, setTxnType] = useState<string>("CashWithdrawal");
  const [txnDate, setTxnDate] = useState(today());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [additionalFees, setAdditionalFees] = useState<number | "">("");
  const [sourceAccountId, setSourceAccountId] = useState<number | "">("");
  const [destinationAccountId, setDestinationAccountId] = useState<number | "">("");
  const [spendingCategoryId, setSpendingCategoryId] = useState<number | "">("");
  const [incomeCategory, setIncomeCategory] = useState<string>("");
  const [principalPortion, setPrincipalPortion] = useState<number | "">("");
  const [interestPortion, setInterestPortion] = useState<number | "">("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function loadTransactions() {
    setLoading(true);
    api
      .listTransactions({ from: dateFrom || undefined, to: dateTo || undefined })
      .then(setTransactions)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    Promise.all([api.listAccounts(), api.listCategories(), api.transactionRules()]).then(([acc, cats, rulesResp]) => {
      setAccounts(acc);
      setCategories(cats);
      setRules(rulesResp.rules);
      setIncomeCategories(rulesResp.incomeCategories);
    });
  }, []);

  useEffect(loadTransactions, [dateFrom, dateTo]);

  function loadAll() {
    loadTransactions();
  }

  async function handleVoid(id: number) {
    if (!confirm("Void this transaction? This reverses its balance effect (and its paired leg's, if any) — it does not delete history (2.6).")) return;
    try {
      await api.voidTransaction(id);
      loadAll();
    } catch (err) {
      alert(err instanceof ApiError ? err.errors.join(" ") : "Something went wrong.");
    }
  }

  // Groups preserve first-appearance order — since transactions arrive
  // sorted by txn_date DESC, that means the type with the most recent
  // activity shows first, with no separate sort pass needed.
  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of transactions) {
      const list = map.get(t.txnType);
      if (list) list.push(t);
      else map.set(t.txnType, [t]);
    }
    return Array.from(map.entries());
  }, [transactions]);

  function toggleType(type: string) {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function groupTotalMinor(group: Transaction[]): number {
    return group.reduce((sum, t) => {
      if (t.status === "Voided") return sum;
      return sum + (t.indicator === "Debit" ? -t.amountMinor : t.amountMinor);
    }, 0);
  }

  const rule = rules[txnType];

  const sourceOptions = useMemo(() => {
    if (!rule) return [];
    const types = rule.legs === "single" ? rule.accountTypes! : rule.sourceAccountTypes!;
    return accounts.filter((a) => a.status === "Active" && types.includes(a.accountType));
  }, [rule, accounts]);

  const destOptions = useMemo(() => {
    if (!rule || rule.legs !== "two") return [];
    return accounts
      .filter((a) => a.status === "Active" && rule.destAccountTypes!.includes(a.accountType))
      .filter((a) => a.id !== sourceAccountId);
  }, [rule, accounts, sourceAccountId]);

  // Reset the parts of the form that don't carry over when the type changes.
  function handleTypeChange(newType: string) {
    setTxnType(newType);
    setSourceAccountId("");
    setDestinationAccountId("");
    setSpendingCategoryId("");
    setIncomeCategory("");
    setPrincipalPortion("");
    setInterestPortion("");
    setErrors([]);
  }

  function suggestSplit() {
    if (amount === "") return;
    const debtAccount = accounts.find((a) => a.id === destinationAccountId);
    const rate = debtAccount?.interestRatePct;
    if (!debtAccount || rate == null) return;
    const balance = debtAccount.accountType === "CreditCard" ? debtAccount.cardBalanceMinor ?? 0 : debtAccount.currentBalanceMinor ?? 0;
    const monthlyInterestMinor = Math.round((balance * (rate / 100)) / 12);
    const amountMinor = toMinorUnits(amount);
    const interest = Math.min(monthlyInterestMinor, amountMinor);
    setInterestPortion(interest / 100);
    setPrincipalPortion((amountMinor - interest) / 100);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rule || amount === "" || sourceAccountId === "") {
      setErrors(["Fill in the required fields."]);
      return;
    }
    setSubmitting(true);
    setErrors([]);
    try {
      await api.createTransaction({
        txnType,
        txnDate,
        description: description || undefined,
        amountMinor: toMinorUnits(amount),
        additionalFeesMinor: additionalFees === "" ? undefined : toMinorUnits(additionalFees),
        sourceAccountId: Number(sourceAccountId),
        destinationAccountId: destinationAccountId === "" ? undefined : Number(destinationAccountId),
        spendingCategoryId: spendingCategoryId === "" ? undefined : Number(spendingCategoryId),
        incomeCategory: incomeCategory || undefined,
        principalPortionMinor: principalPortion === "" ? undefined : toMinorUnits(principalPortion),
        interestPortionMinor: interestPortion === "" ? undefined : toMinorUnits(interestPortion),
      });
      setAmount("");
      setAdditionalFees("");
      setDescription("");
      setPrincipalPortion("");
      setInterestPortion("");
      loadAll();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSubmitting(false);
    }
  }

  function accountLabel(a: Account) {
    return `${a.accountName} (${a.accountType})`;
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Transactions</h1>
        <p className="page-subtitle">
          Every dollar tracked has to visibly go somewhere (2.5) — pick a type below and the form
          adapts to what that type needs.
        </p>
      </header>

      <section className="transactions-list">
        <div className="field-row txn-filters">
          <label>
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          {(dateFrom || dateTo) && (
            <label>
              &nbsp;
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
              >
                Clear dates
              </button>
            </label>
          )}
          {groups.length > 0 && (
            <>
              <label>
                &nbsp;
                <button type="button" className="secondary" onClick={() => setCollapsedTypes(new Set(groups.map(([type]) => type)))}>
                  Collapse all
                </button>
              </label>
              <label>
                &nbsp;
                <button type="button" className="secondary" onClick={() => setCollapsedTypes(new Set())}>
                  Expand all
                </button>
              </label>
            </>
          )}
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : transactions.length === 0 ? (
          <p className="muted">No transactions in this range.</p>
        ) : (
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Account</th>
                <th>Category</th>
                <th className="numeric">Amount</th>
                <th>Counterparty</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            {groups.map(([type, group]) => {
              const collapsed = collapsedTypes.has(type);
              const total = groupTotalMinor(group);
              return (
                <tbody key={type}>
                  <tr className="txn-group-header" onClick={() => toggleType(type)}>
                    <td colSpan={4}>
                      <span className={`txn-group-caret ${collapsed ? "collapsed" : ""}`}>▾</span>
                      {TXN_TYPE_LABELS[type] ?? type} ({group.length})
                    </td>
                    <td className="numeric">
                      {total < 0 ? "-" : "+"}
                      {formatMinor(Math.abs(total), baseCurrency)}
                    </td>
                    <td colSpan={3}></td>
                  </tr>
                  {!collapsed &&
                    group.map((t) => (
                      <tr key={t.id} className={t.status === "Voided" ? "txn-voided" : undefined}>
                        <td>{t.txnDate}</td>
                        <td>{TXN_TYPE_LABELS[t.txnType] ?? t.txnType}</td>
                        <td>{t.sourceAccountName}</td>
                        <td className="muted">{t.spendingCategoryName ?? t.incomeCategory ?? "—"}</td>
                        <td className="numeric">
                          {t.indicator === "Debit" ? "-" : "+"}
                          {formatMinor(t.amountMinor, baseCurrency)}
                        </td>
                        <td className="muted">
                          {t.destinationAccountName
                            ? t.indicator === "Debit"
                              ? `→ ${t.destinationAccountName}`
                              : `← ${t.destinationAccountName}`
                            : "—"}
                        </td>
                        <td>
                          {t.status !== "Posted" && (
                            <span className={`status-pill status-${t.status.toLowerCase()}`}>{t.status}</span>
                          )}
                        </td>
                        <td>
                          {t.status === "Posted" && (
                            <button type="button" className="secondary" onClick={() => handleVoid(t.id)}>
                              Void
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              );
            })}
          </table>
          </div>
        )}
      </section>

      <section className="new-transaction-form">
        <h2>Add a transaction</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label>
              Type
              <select value={txnType} onChange={(e) => handleTypeChange(e.target.value)}>
                {Object.keys(rules).map((t) => (
                  <option key={t} value={t}>
                    {TXN_TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} />
            </label>
            <label>
              Description
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>

          <div className="field-row">
            <label>
              {rule?.legs === "two" ? "From account" : "Account"}
              <select value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Select…</option>
                {sourceOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            {rule?.legs === "two" && (
              <label>
                To account
                <select
                  value={destinationAccountId}
                  onChange={(e) => setDestinationAccountId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">Select…</option>
                  {destOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Amount
              <input
                type="number"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </label>
            <label>
              Additional fees
              <input
                type="number"
                step="0.01"
                value={additionalFees}
                onChange={(e) => setAdditionalFees(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </label>
          </div>

          {rule?.categoryKind === "spending" && (
            <div className="field-row">
              {rule.categoryOverridable || rule.legs === "single" ? (
                <label>
                  Spending category
                  <select
                    value={spendingCategoryId}
                    onChange={(e) => setSpendingCategoryId(e.target.value ? Number(e.target.value) : "")}
                  >
                    <option value="">Select…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="muted">Category: {rule.defaultCategoryName} (fixed for this transaction type)</p>
              )}
            </div>
          )}

          {rule?.categoryKind === "income" && (
            <div className="field-row">
              <label>
                Income category
                <select value={incomeCategory} onChange={(e) => setIncomeCategory(e.target.value)}>
                  <option value="">Select…</option>
                  {incomeCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {rule?.requiresPrincipalInterestSplit && (
            <div className="field-row">
              <label>
                Principal portion
                <input
                  type="number"
                  step="0.01"
                  value={principalPortion}
                  onChange={(e) => setPrincipalPortion(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </label>
              <label>
                Interest portion
                <input
                  type="number"
                  step="0.01"
                  value={interestPortion}
                  onChange={(e) => setInterestPortion(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </label>
              <label>
                &nbsp;
                <button type="button" onClick={suggestSplit} className="secondary">
                  Suggest split
                </button>
              </label>
            </div>
          )}

          {errors.length > 0 && (
            <ul className="form-errors">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add transaction"}
          </button>
        </form>
      </section>
    </div>
  );
}
