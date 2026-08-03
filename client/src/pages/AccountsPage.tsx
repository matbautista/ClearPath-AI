import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { formatMinor, toMinorUnits } from "../lib/money";
import { useSettings } from "../SettingsContext";
import type { Account, AccountType, NewAccountInput } from "../types";

const ACCOUNT_TYPES: AccountType[] = ["Cash", "Bank", "EWallet", "Investment", "Loan", "CreditCard"];

const TYPE_LABELS: Record<AccountType, string> = {
  Cash: "Cash",
  Bank: "Bank",
  EWallet: "E-Wallet",
  Investment: "Investment",
  Loan: "Loan",
  CreditCard: "Credit Card",
};

function emptyForm(): Partial<NewAccountInput> & { accountType: AccountType } {
  return { accountType: "Cash", accountName: "" };
}

export function AccountsPage() {
  const { baseCurrency } = useSettings();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm());
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    setLoading(true);
    api
      .listAccounts()
      .then(setAccounts)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.accountName?.trim()) {
      setFormErrors(["Account name is required."]);
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      await api.createAccount(form as NewAccountInput);
      setForm(emptyForm());
      load();
    } catch (err) {
      setFormErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSubmitting(false);
    }
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

  const isCreditCard = form.accountType === "CreditCard";
  const isLoan = form.accountType === "Loan";
  const isLoanOrCard = isLoan || isCreditCard;

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
        {loading ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">No accounts yet — add your first one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Institution</th>
                <th className="numeric">Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.accountName}</td>
                  <td>{TYPE_LABELS[a.accountType]}</td>
                  <td className="muted">{a.institutionName ?? "—"}</td>
                  <td className="numeric">{balanceDisplay(a)}</td>
                  <td>
                    <span className={`status-pill status-${a.status.toLowerCase()}`}>{a.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="new-account-form">
        <h2>Add an account</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label>
              Type
              <select
                value={form.accountType}
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
                placeholder={form.accountType === "Cash" ? "e.g. Wallet" : form.accountType === "EWallet" ? "e.g. GCash" : "e.g. BPI Savings"}
              />
            </label>
            {form.accountType !== "Cash" && (
              <label>
                Institution
                <input
                  type="text"
                  value={form.institutionName ?? ""}
                  onChange={(e) => setForm({ ...form, institutionName: e.target.value })}
                />
              </label>
            )}
          </div>

          <div className="field-row">
            <label>
              {isCreditCard ? "Current balance owed" : "Beginning balance"}
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

          {formErrors.length > 0 && (
            <ul className="form-errors">
              {formErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add account"}
          </button>
        </form>
      </section>
    </div>
  );
}
