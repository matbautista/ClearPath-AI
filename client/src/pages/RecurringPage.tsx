import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type Utility,
  type IncomeSource,
  type TaxFee,
  type PendingTransaction,
  type Schedule,
} from "../api";
import { INCOME_CATEGORIES } from "../lib/incomeCategories";
import { formatMinor, toMinorUnits } from "../lib/money";
import { useSettings } from "../SettingsContext";
import type { Account } from "../types";

const SCHEDULES: Schedule[] = ["Monthly", "Bi-Monthly", "Quarterly", "Annually", "Variable"];

function SchedulePicker({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Schedule)}>
      {SCHEDULES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function PendingPanel({ pending, onChange }: { pending: PendingTransaction[]; onChange: () => void }) {
  const [overrides, setOverrides] = useState<Record<number, number | "">>({});

  async function confirm(id: number) {
    const override = overrides[id];
    await api.confirmPending(id, override === "" || override == null ? undefined : toMinorUnits(override));
    onChange();
  }
  async function skip(id: number) {
    await api.skipPending(id);
    onChange();
  }

  if (pending.length === 0) return null;

  return (
    <section className="pending-panel">
      <h2>Pending confirmations</h2>
      <p className="page-subtitle">
        Auto-drafted from your Recurring Rules (2.7) — nothing here has touched your account
        balances yet. Confirm to post it, or skip to discard.
      </p>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Account</th>
            <th>Category</th>
            <th className="numeric">Amount</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pending.map((p) => (
            <tr key={p.id}>
              <td>{p.txnDate}</td>
              <td>{p.sourceAccountName}</td>
              <td className="muted">{p.spendingCategoryName ?? p.incomeCategory}</td>
              <td className="numeric">
                <input
                  type="number"
                  step="0.01"
                  value={overrides[p.id] ?? p.amountMinor / 100}
                  onChange={(e) => setOverrides({ ...overrides, [p.id]: e.target.value === "" ? "" : Number(e.target.value) })}
                  style={{ width: 100, textAlign: "right" }}
                />
              </td>
              <td>
                <button type="button" className="secondary" onClick={() => confirm(p.id)}>
                  Confirm
                </button>{" "}
                <button type="button" className="secondary" onClick={() => skip(p.id)}>
                  Skip
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type RecurringTab = "utilities" | "income" | "taxfees";

const TABS: { key: RecurringTab; label: string }[] = [
  { key: "utilities", label: "Utilities" },
  { key: "income", label: "Income Sources" },
  { key: "taxfees", label: "Taxes & Other Regulatory Fees" },
];

export function RecurringPage() {
  const { baseCurrency } = useSettings();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [utilities, setUtilities] = useState<Utility[]>([]);
  const [incomeSources, setIncomeSources] = useState<IncomeSource[]>([]);
  const [taxFees, setTaxFees] = useState<TaxFee[]>([]);
  const [pending, setPending] = useState<PendingTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<RecurringTab>("utilities");

  function loadAll() {
    setLoading(true);
    Promise.all([api.listAccounts(), api.listUtilities(), api.listIncomeSources(), api.listTaxFees(), api.listPending()])
      .then(([a, u, i, t, p]) => {
        setAccounts(a.filter((acc) => acc.status === "Active"));
        setUtilities(u);
        setIncomeSources(i);
        setTaxFees(t);
        setPending(p);
      })
      .finally(() => setLoading(false));
  }

  useEffect(loadAll, []);

  if (loading) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Recurring</h1>
        <p className="page-subtitle">
          Utilities, income sources, and taxes/fees each get a Recurring Rule that auto-drafts a
          Pending Confirmation transaction on schedule — nothing posts until you confirm it (2.7).
        </p>
      </header>

      <PendingPanel pending={pending} onChange={loadAll} />

      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={activeTab === t.key ? "tab-active" : "tab-button"}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "utilities" && (
        <UtilitiesSection utilities={utilities} accounts={accounts} baseCurrency={baseCurrency} onChange={loadAll} />
      )}
      {activeTab === "income" && (
        <IncomeSourcesSection incomeSources={incomeSources} accounts={accounts} baseCurrency={baseCurrency} onChange={loadAll} />
      )}
      {activeTab === "taxfees" && (
        <TaxFeesSection taxFees={taxFees} accounts={accounts} baseCurrency={baseCurrency} onChange={loadAll} />
      )}
    </div>
  );
}

function UtilitiesSection({
  utilities,
  accounts,
  baseCurrency,
  onChange,
}: {
  utilities: Utility[];
  accounts: Account[];
  baseCurrency: string;
  onChange: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [providerName, setProviderName] = useState("");
  const [defaultAccountId, setDefaultAccountId] = useState<number | "">("");
  const [dueDateDay, setDueDateDay] = useState<number | "">("");
  const [cutOffDateDay, setCutOffDateDay] = useState<number | "">("");
  const [policyType, setPolicyType] = useState("");
  const [schedule, setSchedule] = useState<Schedule>("Monthly");
  const [templateAmount, setTemplateAmount] = useState<number | "">("");
  const [nextRunDate, setNextRunDate] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function resetForm() {
    setEditingId(null);
    setProviderName("");
    setDefaultAccountId("");
    setDueDateDay("");
    setCutOffDateDay("");
    setPolicyType("");
    setTemplateAmount("");
    setNextRunDate("");
    setErrors([]);
  }

  function startEdit(u: Utility) {
    setEditingId(u.id);
    setProviderName(u.providerName);
    setDefaultAccountId(u.defaultAccountId);
    setDueDateDay(u.dueDateDay ?? "");
    setCutOffDateDay(u.cutOffDateDay ?? "");
    setPolicyType(u.policyType ?? "");
    setSchedule(u.schedule);
    setTemplateAmount(u.templateAmountMinor / 100);
    setNextRunDate(u.nextRunDate ?? "");
    setErrors([]);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  // "Day of month" only unambiguously identifies a date for schedules that
  // recur every month — Quarterly/Annually/Variable utilities would need a
  // month too, and since these fields aren't used to compute due dates
  // anyway (Upcoming Dues reads the Recurring Rule's Next Run Date for
  // Utilities, unlike Loan/Credit Card accounts where Due Date Day is load-
  // bearing — see dashboardEngine.ts), just hide them rather than let them
  // record a half-specified date.
  const showDayOfMonthFields = schedule === "Monthly" || schedule === "Bi-Monthly";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (defaultAccountId === "" || templateAmount === "") return;
    setErrors([]);
    try {
      const input = {
        providerName,
        defaultAccountId: Number(defaultAccountId),
        dueDateDay: showDayOfMonthFields && dueDateDay !== "" ? Number(dueDateDay) : undefined,
        cutOffDateDay: showDayOfMonthFields && cutOffDateDay !== "" ? Number(cutOffDateDay) : undefined,
        policyType: policyType.trim() === "" ? undefined : policyType.trim(),
        schedule,
        templateAmountMinor: toMinorUnits(templateAmount),
        nextRunDate: schedule === "Variable" ? undefined : nextRunDate,
      };
      if (editingId != null) {
        await api.updateUtility(editingId, input);
      } else {
        await api.createUtility(input);
      }
      resetForm();
      onChange();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    }
  }

  return (
    <>
      <section className="utilities-list">
        <h2>Utilities</h2>
        {utilities.length === 0 ? (
          <p className="muted">No utilities yet — add your first one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Policy type</th>
                <th>Paid from</th>
                <th>Schedule</th>
                <th className="numeric">Amount</th>
                <th>Next run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {utilities.map((u) => (
                <tr key={u.id}>
                  <td>{u.providerName}</td>
                  <td className="muted">{u.policyType ?? "—"}</td>
                  <td className="muted">{u.defaultAccountName}</td>
                  <td className="muted">{u.schedule}</td>
                  <td className="numeric">{formatMinor(u.templateAmountMinor, baseCurrency)}</td>
                  <td className="muted">{u.nextRunDate ?? "—"}</td>
                  <td>
                    <button type="button" className="secondary" onClick={() => startEdit(u)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="new-utility-form">
        <h2>{editingId != null ? "Edit utility" : "Add a utility"}</h2>
        <form onSubmit={handleSubmit}>
        <div className="field-row field-row-even">
          <label>
            Provider name
            <input type="text" value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="e.g. Meralco" />
          </label>
          <label>
            Policy type (optional)
            <input
              type="text"
              value={policyType}
              onChange={(e) => setPolicyType(e.target.value)}
              placeholder="e.g. Life, Health, Auto — leave blank for non-insurance"
            />
          </label>
          <label>
            Paid from
            <select value={defaultAccountId} onChange={(e) => setDefaultAccountId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {showDayOfMonthFields && (
          <div className="field-row field-row-even">
            <label>
              Cut-off date (day of month)
              <input
                type="number"
                min={1}
                max={31}
                value={cutOffDateDay}
                onChange={(e) => setCutOffDateDay(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </label>
            <label>
              Due date (day of month)
              <input type="number" min={1} max={31} value={dueDateDay} onChange={(e) => setDueDateDay(e.target.value === "" ? "" : Number(e.target.value))} />
            </label>
          </div>
        )}
        <div className="field-row field-row-even">
          <label>
            Schedule
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </label>
          <label>
            Typical amount
            <input type="number" step="0.01" value={templateAmount} onChange={(e) => setTemplateAmount(e.target.value === "" ? "" : Number(e.target.value))} />
          </label>
          {editingId == null && schedule !== "Variable" && (
            <label>
              Next run date
              <input type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} />
            </label>
          )}
        </div>
        {editingId != null && (
          <p className="muted">
            Next run date can't be changed here — it's managed by the missed-run catch-up schedule (2.7). Create a
            new utility if you need a different one.
          </p>
        )}
        {errors.length > 0 && (
          <ul className="form-errors">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        <button type="submit">{editingId != null ? "Save changes" : "Add utility"}</button>
        {editingId != null && (
          <button type="button" className="secondary" onClick={resetForm} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        )}
        </form>
      </section>
    </>
  );
}

function IncomeSourcesSection({
  incomeSources,
  accounts,
  baseCurrency,
  onChange,
}: {
  incomeSources: IncomeSource[];
  accounts: Account[];
  baseCurrency: string;
  onChange: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [incomeCategory, setIncomeCategory] = useState<string>(INCOME_CATEGORIES[0]);
  const [creditToAccountId, setCreditToAccountId] = useState<number | "">("");
  const [schedule, setSchedule] = useState<Schedule>("Monthly");
  const [templateAmount, setTemplateAmount] = useState<number | "">("");
  const [nextRunDate, setNextRunDate] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function resetForm() {
    setEditingId(null);
    setSourceName("");
    setIncomeCategory(INCOME_CATEGORIES[0]);
    setCreditToAccountId("");
    setSchedule("Monthly");
    setTemplateAmount("");
    setNextRunDate("");
    setErrors([]);
  }

  function startEdit(i: IncomeSource) {
    setEditingId(i.id);
    setSourceName(i.sourceName);
    setIncomeCategory(i.incomeCategory);
    setCreditToAccountId(i.creditToAccountId);
    setSchedule(i.schedule);
    setTemplateAmount(i.templateAmountMinor / 100);
    setNextRunDate(i.nextRunDate ?? "");
    setErrors([]);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (creditToAccountId === "" || templateAmount === "") return;
    setErrors([]);
    try {
      const input = {
        sourceName,
        incomeCategory,
        creditToAccountId: Number(creditToAccountId),
        schedule,
        templateAmountMinor: toMinorUnits(templateAmount),
        nextRunDate: schedule === "Variable" ? undefined : nextRunDate,
      };
      if (editingId != null) {
        await api.updateIncomeSource(editingId, input);
      } else {
        await api.createIncomeSource(input);
      }
      resetForm();
      onChange();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    }
  }

  return (
    <>
      <section className="income-sources-list">
        <h2>Income Sources</h2>
        {incomeSources.length === 0 ? (
          <p className="muted">No income sources yet — add your first one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Category</th>
                <th>Credited to</th>
                <th>Schedule</th>
                <th className="numeric">Amount</th>
                <th>Next run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {incomeSources.map((i) => (
                <tr key={i.id}>
                  <td>{i.sourceName}</td>
                  <td className="muted">{i.incomeCategory}</td>
                  <td className="muted">{i.creditToAccountName}</td>
                  <td className="muted">{i.schedule}</td>
                  <td className="numeric">{formatMinor(i.templateAmountMinor, baseCurrency)}</td>
                  <td className="muted">{i.nextRunDate ?? "—"}</td>
                  <td>
                    <button type="button" className="secondary" onClick={() => startEdit(i)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="new-income-source-form">
        <h2>{editingId != null ? "Edit income source" : "Add an income source"}</h2>
        <form onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Source name
            <input type="text" value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="e.g. Day Job" />
          </label>
          <label>
            Income category
            <select value={incomeCategory} onChange={(e) => setIncomeCategory(e.target.value)}>
              {INCOME_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Credit to
            <select value={creditToAccountId} onChange={(e) => setCreditToAccountId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label>
            Schedule
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </label>
          <label>
            Gross amount
            <input type="number" step="0.01" value={templateAmount} onChange={(e) => setTemplateAmount(e.target.value === "" ? "" : Number(e.target.value))} />
          </label>
          {editingId == null && schedule !== "Variable" && (
            <label>
              Next run date
              <input type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} />
            </label>
          )}
        </div>
        {editingId != null && (
          <p className="muted">
            Next run date can't be changed here — it's managed by the missed-run catch-up schedule (2.7). Create a
            new income source if you need a different one.
          </p>
        )}
        {errors.length > 0 && (
          <ul className="form-errors">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        <button type="submit">{editingId != null ? "Save changes" : "Add income source"}</button>
        {editingId != null && (
          <button type="button" className="secondary" onClick={resetForm} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        )}
        </form>
      </section>
    </>
  );
}

function TaxFeesSection({
  taxFees,
  accounts,
  baseCurrency,
  onChange,
}: {
  taxFees: TaxFee[];
  accounts: Account[];
  baseCurrency: string;
  onChange: () => void;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [regulatoryName, setRegulatoryName] = useState("");
  const [feeCategory, setFeeCategory] = useState("");
  const [debitFromAccountId, setDebitFromAccountId] = useState<number | "">("");
  const [schedule, setSchedule] = useState<Schedule>("Annually");
  const [templateAmount, setTemplateAmount] = useState<number | "">("");
  const [nextRunDate, setNextRunDate] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  function resetForm() {
    setEditingId(null);
    setRegulatoryName("");
    setFeeCategory("");
    setDebitFromAccountId("");
    setSchedule("Annually");
    setTemplateAmount("");
    setNextRunDate("");
    setErrors([]);
  }

  function startEdit(t: TaxFee) {
    setEditingId(t.id);
    setRegulatoryName(t.regulatoryName);
    setFeeCategory(t.feeCategory ?? "");
    setDebitFromAccountId(t.debitFromAccountId);
    setSchedule(t.schedule);
    setTemplateAmount(t.templateAmountMinor / 100);
    setNextRunDate(t.nextRunDate ?? "");
    setErrors([]);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (debitFromAccountId === "" || templateAmount === "") return;
    setErrors([]);
    try {
      const input = {
        regulatoryName,
        feeCategory: feeCategory || undefined,
        debitFromAccountId: Number(debitFromAccountId),
        schedule,
        templateAmountMinor: toMinorUnits(templateAmount),
        nextRunDate: schedule === "Variable" ? undefined : nextRunDate,
      };
      if (editingId != null) {
        await api.updateTaxFee(editingId, input);
      } else {
        await api.createTaxFee(input);
      }
      resetForm();
      onChange();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    }
  }

  return (
    <>
      <section className="tax-fees-list">
        <h2>Taxes &amp; Other Regulatory Fees</h2>
        {taxFees.length === 0 ? (
          <p className="muted">No taxes/fees yet — add your first one below.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Paid from</th>
                <th>Schedule</th>
                <th className="numeric">Amount</th>
                <th>Next run</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {taxFees.map((t) => (
                <tr key={t.id}>
                  <td>{t.regulatoryName}</td>
                  <td className="muted">{t.debitFromAccountName}</td>
                  <td className="muted">{t.schedule}</td>
                  <td className="numeric">{formatMinor(t.templateAmountMinor, baseCurrency)}</td>
                  <td className="muted">{t.nextRunDate ?? "—"}</td>
                  <td>
                    <button type="button" className="secondary" onClick={() => startEdit(t)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="new-tax-fee-form">
        <h2>{editingId != null ? "Edit tax/fee" : "Add a tax/fee"}</h2>
        <form onSubmit={handleSubmit}>
        <div className="field-row">
          <label>
            Regulatory name
            <input type="text" value={regulatoryName} onChange={(e) => setRegulatoryName(e.target.value)} placeholder="e.g. BIR Annual Registration" />
          </label>
          <label>
            Fee category (optional)
            <input type="text" value={feeCategory} onChange={(e) => setFeeCategory(e.target.value)} />
          </label>
          <label>
            Paid from
            <select value={debitFromAccountId} onChange={(e) => setDebitFromAccountId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Select…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label>
            Schedule
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </label>
          <label>
            Typical amount
            <input type="number" step="0.01" value={templateAmount} onChange={(e) => setTemplateAmount(e.target.value === "" ? "" : Number(e.target.value))} />
          </label>
          {editingId == null && schedule !== "Variable" && (
            <label>
              Next run date
              <input type="date" value={nextRunDate} onChange={(e) => setNextRunDate(e.target.value)} />
            </label>
          )}
        </div>
        {editingId != null && (
          <p className="muted">
            Next run date can't be changed here — it's managed by the missed-run catch-up schedule (2.7). Create a
            new tax/fee if you need a different one.
          </p>
        )}
        {errors.length > 0 && (
          <ul className="form-errors">
            {errors.map((err) => (
              <li key={err}>{err}</li>
            ))}
          </ul>
        )}
        <button type="submit">{editingId != null ? "Save changes" : "Add tax/fee"}</button>
        {editingId != null && (
          <button type="button" className="secondary" onClick={resetForm} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        )}
        </form>
      </section>
    </>
  );
}
