import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinor, toMinorUnits } from "../lib/money";
import { useSettings } from "../SettingsContext";
import type { Account, AccountStatus, AccountType, NewAccountInput } from "../types";

const ACCOUNT_TYPES: AccountType[] = ["Cash", "Bank", "EWallet", "Investment", "Loan", "CreditCard", "RealEstate"];

const TYPE_LABELS: Record<AccountType, string> = {
  Cash: "Cash",
  Bank: "Bank",
  EWallet: "E-Wallet",
  Investment: "Investment",
  Loan: "Loan",
  CreditCard: "Credit Card",
  RealEstate: "Real Estate",
};

type FormState = Partial<NewAccountInput> & { accountType: AccountType; status?: AccountStatus };

function emptyForm(): FormState {
  return { accountType: "Cash", accountName: "" };
}

export function AccountsPage() {
  const { baseCurrency } = useSettings();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<AccountType | "All">("All");
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "All">("All");
  const [collapsedTypes, setCollapsedTypes] = useState<Set<AccountType>>(new Set());

  function load() {
    setLoading(true);
    api
      .listAccounts()
      .then(setAccounts)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm());
    setFormErrors([]);
  }

  function startEdit(a: Account) {
    setEditingId(a.id);
    setForm({
      accountType: a.accountType,
      accountName: a.accountName,
      institutionName: a.institutionName ?? undefined,
      beginningBalanceMinor: a.beginningBalanceMinor,
      interestRatePct: a.interestRatePct ?? undefined,
      minimumPaymentMinor: a.minimumPaymentMinor ?? undefined,
      creditLimitMinor: a.creditLimitMinor ?? undefined,
      loanAmountMinor: a.loanAmountMinor ?? undefined,
      dueDateDay: a.dueDateDay ?? undefined,
      cutOffDateDay: a.cutOffDateDay ?? undefined,
      status: a.status,
    });
    setFormErrors([]);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.accountName?.trim()) {
      setFormErrors(["Account name is required."]);
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      if (editingId != null) {
        await api.updateAccount(editingId, {
          accountName: form.accountName,
          institutionName: form.institutionName,
          beginningBalanceMinor: form.beginningBalanceMinor,
          interestRatePct: form.interestRatePct,
          minimumPaymentMinor: form.minimumPaymentMinor,
          creditLimitMinor: form.creditLimitMinor,
          loanAmountMinor: form.loanAmountMinor,
          dueDateDay: form.dueDateDay,
          cutOffDateDay: form.cutOffDateDay,
          status: form.status ?? "Active",
        });
      } else {
        await api.createAccount(form as NewAccountInput);
      }
      resetForm();
      load();
    } catch (err) {
      setFormErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSubmitting(false);
    }
  }

  // A Loan sitting at a zero balance isn't auto-closed anywhere (nothing in
  // the schema or the recurring/dashboard jobs watches for this) — left
  // alone, it stays "Active" forever and keeps showing up in the
  // Dashboard's Upcoming Dues with its old minimum payment amount, even
  // though nothing is actually owed. This just flags it so the user
  // notices and can close it themselves.
  function isPaidOffLoan(account: Account): boolean {
    return account.accountType === "Loan" && account.status === "Active" && (account.currentBalanceMinor ?? 0) === 0;
  }

  async function closeAccount(account: Account) {
    await api.updateAccount(account.id, {
      accountName: account.accountName,
      institutionName: account.institutionName ?? undefined,
      beginningBalanceMinor: account.beginningBalanceMinor,
      interestRatePct: account.interestRatePct ?? undefined,
      minimumPaymentMinor: account.minimumPaymentMinor ?? undefined,
      creditLimitMinor: account.creditLimitMinor ?? undefined,
      loanAmountMinor: account.loanAmountMinor ?? undefined,
      dueDateDay: account.dueDateDay ?? undefined,
      cutOffDateDay: account.cutOffDateDay ?? undefined,
      status: "Closed",
    });
    load();
  }

  function balanceDisplay(account: Account) {
    if (account.accountType === "CreditCard") {
      return (
        <>
          <div className="balance-primary">{formatMinor(account.cardBalanceMinor ?? 0, baseCurrency)} owed</div>
          <div className="balance-secondary">
            {formatMinor(account.availableBalanceMinor ?? 0, baseCurrency)} available
          </div>
        </>
      );
    }
    return <div className="balance-primary">{formatMinor(account.currentBalanceMinor ?? 0, baseCurrency)}</div>;
  }

  // Credit Card balance is "owed", tracked in its own column
  // (card_balance_minor) rather than current_balance_minor — same split
  // balanceDisplay already makes, kept in one place so a group subtotal
  // means the same thing as the row above it.
  function accountBalanceMinor(account: Account): number {
    return account.accountType === "CreditCard" ? account.cardBalanceMinor ?? 0 : account.currentBalanceMinor ?? 0;
  }

  function toggleType(type: AccountType) {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const isCreditCard = form.accountType === "CreditCard";
  const isLoan = form.accountType === "Loan";
  const isLoanOrCard = isLoan || isCreditCard;
  const isRealEstate = form.accountType === "RealEstate";
  const editingAccount = editingId != null ? accounts.find((a) => a.id === editingId) ?? null : null;
  const balanceIsCorrectable = editingId == null || editingAccount?.hasTransactions === false;

  const filteredAccounts = accounts.filter(
    (a) => (typeFilter === "All" || a.accountType === typeFilter) && (statusFilter === "All" || a.status === statusFilter)
  );

  // Fixed canonical order (ACCOUNT_TYPES) rather than first-appearance —
  // unlike transaction types, account types are a small fixed enum, so a
  // stable known order reads better than one that reshuffles as filters change.
  const accountGroups = ACCOUNT_TYPES.map((type) => ({
    type,
    accounts: filteredAccounts.filter((a) => a.accountType === type),
  })).filter((g) => g.accounts.length > 0);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Accounts</h1>
        <p className="page-subtitle">
          Cash, bank, investment, loan, and credit card accounts all live here — the unified
          foundation everything else in ClearPath AI builds on.
        </p>
      </header>

      <section className="accounts-list">
        {!loading && accounts.length > 0 && (
          <div className="field-row" style={{ marginBottom: 20 }}>
            <label>
              Filter by type
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as AccountType | "All")}>
                <option value="All">All types</option>
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Filter by status
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as AccountStatus | "All")}>
                <option value="All">All statuses</option>
                <option value="Active">Active</option>
                <option value="Closed">Closed</option>
              </select>
            </label>
          </div>
        )}
        {!loading && accountGroups.length > 1 && (
          <div className="field-row" style={{ marginBottom: 12 }}>
            <label>
              &nbsp;
              <button
                type="button"
                className="secondary"
                onClick={() => setCollapsedTypes(new Set(accountGroups.map((g) => g.type)))}
              >
                Collapse all
              </button>
            </label>
            <label>
              &nbsp;
              <button type="button" className="secondary" onClick={() => setCollapsedTypes(new Set())}>
                Expand all
              </button>
            </label>
          </div>
        )}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">No accounts yet — add your first one below.</p>
        ) : filteredAccounts.length === 0 ? (
          <p className="muted">No accounts match this filter.</p>
        ) : (
          <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Institution</th>
                <th className="numeric">Balance</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            {accountGroups.map(({ type, accounts: group }) => {
              const collapsed = collapsedTypes.has(type);
              const total = group.reduce((sum, a) => sum + accountBalanceMinor(a), 0);
              return (
                <tbody key={type}>
                  <tr className="txn-group-header" onClick={() => toggleType(type)}>
                    <td colSpan={3}>
                      <span className={`txn-group-caret ${collapsed ? "collapsed" : ""}`}>▾</span>
                      {TYPE_LABELS[type]} ({group.length})
                    </td>
                    <td className="numeric">{formatMinor(total, baseCurrency)}</td>
                    <td colSpan={2}></td>
                  </tr>
                  {!collapsed &&
                    group.map((a) => (
                      <tr key={a.id}>
                        <td>{a.accountName}</td>
                        <td>{TYPE_LABELS[a.accountType]}</td>
                        <td className="muted">{a.institutionName ?? "—"}</td>
                        <td className="numeric">{balanceDisplay(a)}</td>
                        <td>
                          <span className={`status-pill status-${a.status.toLowerCase()}`}>{a.status}</span>
                          {isPaidOffLoan(a) && <div className="muted paid-off-note">Paid off</div>}
                        </td>
                        <td className="row-actions">
                          <button type="button" className="secondary" onClick={() => startEdit(a)}>
                            Edit
                          </button>
                          {isPaidOffLoan(a) && (
                            <button type="button" className="secondary" onClick={() => closeAccount(a)} style={{ marginLeft: 6 }}>
                              Close account
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

      <section className="new-account-form">
        <h2>{editingId != null ? "Edit account" : "Add an account"}</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label>
              Type
              <select
                value={form.accountType}
                disabled={editingId != null}
                onChange={(e) => setForm({ ...emptyForm(), accountType: e.target.value as AccountType })}
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Account name
              <input
                type="text"
                value={form.accountName ?? ""}
                onChange={(e) => setForm({ ...form, accountName: e.target.value })}
                placeholder={
                  form.accountType === "Cash"
                    ? "e.g. Wallet"
                    : form.accountType === "EWallet"
                      ? "e.g. GCash"
                      : isRealEstate
                        ? "e.g. Family Home"
                        : "e.g. BPI Savings"
                }
              />
            </label>
            {form.accountType !== "Cash" && !isRealEstate && (
              <label>
                Institution
                <input
                  type="text"
                  value={form.institutionName ?? ""}
                  onChange={(e) => setForm({ ...form, institutionName: e.target.value })}
                />
              </label>
            )}
            {editingId != null && (
              <label>
                Status
                <select
                  value={form.status ?? "Active"}
                  onChange={(e) => setForm({ ...form, status: e.target.value as AccountStatus })}
                >
                  <option value="Active">Active</option>
                  <option value="Closed">Closed</option>
                </select>
              </label>
            )}
          </div>

          <div className="field-row">
            {balanceIsCorrectable && (
              <label>
                {isCreditCard ? "Current balance owed" : isRealEstate ? "Current market value" : "Beginning balance"}
                <input
                  type="number"
                  step="0.01"
                  value={form.beginningBalanceMinor != null ? form.beginningBalanceMinor / 100 : ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      beginningBalanceMinor: e.target.value === "" ? undefined : toMinorUnits(Number(e.target.value)),
                    })
                  }
                />
              </label>
            )}

            {isCreditCard && (
              <label>
                Credit limit
                <input
                  type="number"
                  step="0.01"
                  value={form.creditLimitMinor != null ? form.creditLimitMinor / 100 : ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      creditLimitMinor: e.target.value === "" ? undefined : toMinorUnits(Number(e.target.value)),
                    })
                  }
                />
              </label>
            )}

            {isLoan && (
              <label>
                Loan amount
                <input
                  type="number"
                  step="0.01"
                  value={form.loanAmountMinor != null ? form.loanAmountMinor / 100 : ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      loanAmountMinor: e.target.value === "" ? undefined : toMinorUnits(Number(e.target.value)),
                    })
                  }
                />
              </label>
            )}

            {isLoanOrCard && (
              <label>
                Interest rate (%)
                <input
                  type="number"
                  step="0.01"
                  value={form.interestRatePct ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      interestRatePct: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
              </label>
            )}
          </div>

          {isLoanOrCard && (
            <div className="field-row">
              <label>
                Minimum payment
                <input
                  type="number"
                  step="0.01"
                  value={form.minimumPaymentMinor != null ? form.minimumPaymentMinor / 100 : ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      minimumPaymentMinor: e.target.value === "" ? undefined : toMinorUnits(Number(e.target.value)),
                    })
                  }
                />
              </label>
              <label>
                Due date (day of month)
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={form.dueDateDay ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      dueDateDay: e.target.value === "" ? undefined : Number(e.target.value),
                    })
                  }
                />
              </label>
              {isCreditCard && (
                <label>
                  Cut-off date (day of month)
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={form.cutOffDateDay ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        cutOffDateDay: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
            </div>
          )}

          {editingId != null && (
            <p className="muted">
              Type can't be changed here — a different account type supports different
              transactions, so it would invalidate any history already posted against this
              account. {balanceIsCorrectable
                ? "This account has no transactions yet, so its starting balance above is still safe to correct."
                : "Its starting balance can no longer be corrected here either, since the current balance is now built from posted transaction history — record a correcting transaction instead."}{" "}
              Status can be changed above (e.g. to close the account).
            </p>
          )}

          {formErrors.length > 0 && (
            <ul className="form-errors">
              {formErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : editingId != null ? "Save changes" : "Add account"}
          </button>
          {editingId != null && (
            <button type="button" className="secondary" onClick={resetForm} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
