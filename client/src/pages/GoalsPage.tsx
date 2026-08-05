import { useEffect, useState } from "react";
import { api, ApiError, type Goal } from "../api";
import { formatMinor, toMinorUnits } from "../lib/money";
import { useSettings } from "../SettingsContext";
import type { Account } from "../types";

const GOAL_TYPE_LABELS: Record<Goal["goalType"], string> = {
  DebtPayoff: "Debt Payoff",
  EmergencyFund: "Emergency Fund",
  SavingsTarget: "Savings Target",
  InvestmentTarget: "Investment Target",
  MajorPurchase: "Major Purchase",
};

function GoalCard({ goal, accounts, onChange }: { goal: Goal; accounts: Account[]; onChange: () => void }) {
  const { baseCurrency } = useSettings();
  const [linking, setLinking] = useState(false);
  const [linkAccountId, setLinkAccountId] = useState<number | "">("");
  const [allocationType, setAllocationType] = useState<"FixedAmount" | "Percentage">("Percentage");
  const [allocationValue, setAllocationValue] = useState<number | "">(goal.goalType === "DebtPayoff" ? 100 : "");
  const [errors, setErrors] = useState<string[]>([]);

  const isDebtPayoff = goal.goalType === "DebtPayoff";
  const eligibleAccounts = accounts.filter((a) => {
    if (a.status !== "Active") return false;
    if (goal.links.some((l) => l.accountId === a.id)) return false;
    return isDebtPayoff ? a.accountType === "Loan" || a.accountType === "CreditCard" : true;
  });

  const targetLabel = isDebtPayoff ? "Paid off" : formatMinor(goal.targetAmountMinor, baseCurrency);
  // An unlinked Debt Payoff goal would otherwise show "₱0.00 remaining" —
  // indistinguishable from "this debt is paid off." Call out the empty
  // state explicitly instead; every other goal type already has this
  // covered by its "₱0.00 of ₱X target" phrasing.
  const currentLabel = isDebtPayoff
    ? goal.links.length === 0
      ? "No debts linked yet"
      : `${formatMinor(goal.currentAmountMinor, baseCurrency)} remaining`
    : formatMinor(goal.currentAmountMinor, baseCurrency);
  // Debt Payoff has no stored "starting balance" baseline to compute a
  // proportional fill from, so the bar is binary here: full once every
  // linked debt hits zero (2.8), empty otherwise. Every other goal type
  // fills proportionally toward Target Amount.
  const pct = isDebtPayoff
    ? goal.status === "Completed"
      ? 100
      : 0
    : goal.targetAmountMinor > 0
      ? Math.min(100, Math.round((goal.currentAmountMinor / goal.targetAmountMinor) * 100))
      : 0;

  async function handleLink(e: React.FormEvent) {
    e.preventDefault();
    if (linkAccountId === "" || allocationValue === "") return;
    setErrors([]);
    try {
      await api.addGoalLink(goal.id, {
        accountId: Number(linkAccountId),
        allocationType,
        allocationValue: allocationType === "FixedAmount" ? toMinorUnits(allocationValue) : allocationValue,
      });
      setLinking(false);
      setLinkAccountId("");
      setAllocationValue(isDebtPayoff ? 100 : "");
      onChange();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    }
  }

  async function handleAbandon() {
    await api.abandonGoal(goal.id);
    onChange();
  }

  async function handleUnlink(linkId: number) {
    setErrors([]);
    try {
      await api.unlinkGoalLink(goal.id, linkId);
      onChange();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    }
  }

  return (
    <div className="goal-card">
      <div className="goal-card-header">
        <div>
          <span className="goal-type">{GOAL_TYPE_LABELS[goal.goalType]}</span>
          {goal.strategy && <span className="muted"> · {goal.strategy}</span>}
          {goal.targetDate && <span className="muted"> · by {goal.targetDate}</span>}
        </div>
        <span className={`status-pill status-${goal.status.toLowerCase()}`}>{goal.status}</span>
      </div>

      <div className="progress-row">
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-label">
          {currentLabel} {!isDebtPayoff && <>of {targetLabel}</>}
        </span>
      </div>

      {goal.links.length > 0 && (
        <ul className="goal-links">
          {goal.links.map((l) => (
            <li key={l.id}>
              <span>
                {l.accountName} — {l.allocationType === "FixedAmount" ? formatMinor(l.allocationValue, baseCurrency) : `${l.allocationValue}%`}
              </span>
              <button type="button" className="goal-link-remove" onClick={() => handleUnlink(l.id)} aria-label={`Unlink ${l.accountName}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {(goal.status === "Active" || goal.status === "Completed") && (
        <div className="goal-actions">
          {goal.status === "Active" &&
            (linking ? (
              <form onSubmit={handleLink} className="goal-link-form">
                <select value={linkAccountId} onChange={(e) => setLinkAccountId(e.target.value ? Number(e.target.value) : "")}>
                  <option value="">Select account…</option>
                  {eligibleAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.accountName}
                    </option>
                  ))}
                </select>
                {!isDebtPayoff && (
                  <select value={allocationType} onChange={(e) => setAllocationType(e.target.value as "FixedAmount" | "Percentage")}>
                    <option value="Percentage">%</option>
                    <option value="FixedAmount">Fixed</option>
                  </select>
                )}
                {!isDebtPayoff && (
                  <input
                    type="number"
                    step="0.01"
                    value={allocationValue}
                    onChange={(e) => setAllocationValue(e.target.value === "" ? "" : Number(e.target.value))}
                    placeholder={allocationType === "Percentage" ? "%" : "amount"}
                  />
                )}
                <button type="submit" className="secondary">
                  Link
                </button>
                <button type="button" className="secondary" onClick={() => setLinking(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button type="button" className="secondary" onClick={() => setLinking(true)}>
                + Link account
              </button>
            ))}
          {/* Abandon stays available on a Completed goal too (2.8) — completion is
              a live-derived status, not a one-way ratchet, but the user should still
              be able to archive a goal they consider done rather than have it stick
              around on the list forever with no way to dismiss it. */}
          <button type="button" className="secondary" onClick={handleAbandon}>
            Abandon
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <ul className="form-errors">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GoalsPage() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

  const [goalType, setGoalType] = useState("SavingsTarget");
  const [targetAmount, setTargetAmount] = useState<number | "">("");
  const [targetDate, setTargetDate] = useState("");
  const [strategy, setStrategy] = useState("Snowball");
  const [budget, setBudget] = useState<number | "">("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function loadAll() {
    setLoading(true);
    Promise.all([api.listGoals(), api.listAccounts()])
      .then(([g, a]) => {
        setGoals(g);
        setAccounts(a);
      })
      .finally(() => setLoading(false));
  }

  useEffect(loadAll, []);

  const isDebtPayoff = goalType === "DebtPayoff";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErrors([]);
    try {
      await api.createGoal({
        goalType,
        targetAmountMinor: isDebtPayoff || targetAmount === "" ? undefined : toMinorUnits(targetAmount),
        targetDate: targetDate || undefined,
        strategy: isDebtPayoff ? strategy : undefined,
        totalMonthlyPaymentBudgetMinor: isDebtPayoff && budget !== "" ? toMinorUnits(budget) : undefined,
      });
      setTargetAmount("");
      setTargetDate("");
      setBudget("");
      loadAll();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSubmitting(false);
    }
  }

  const activeGoals = goals.filter((g) => g.status !== "Abandoned");

  return (
    <div className="page">
      <header className="page-header">
        <h1>Goals</h1>
        <p className="page-subtitle">
          Completion is never a manual toggle — it's read straight from linked accounts' live
          balances (2.8), and reverses automatically if a balance moves back the other way.
        </p>
      </header>

      <section className="goals-list">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : activeGoals.length === 0 ? (
          <p className="muted">No goals yet — add one below.</p>
        ) : (
          <div className="goal-cards">
            {activeGoals.map((g) => (
              <GoalCard key={g.id} goal={g} accounts={accounts} onChange={loadAll} />
            ))}
          </div>
        )}
      </section>

      <section className="new-goal-form">
        <h2>Add a goal</h2>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label>
              Type
              <select value={goalType} onChange={(e) => setGoalType(e.target.value)}>
                <option value="SavingsTarget">Savings Target</option>
                <option value="EmergencyFund">Emergency Fund</option>
                <option value="InvestmentTarget">Investment Target</option>
                <option value="MajorPurchase">Major Purchase</option>
                <option value="DebtPayoff">Debt Payoff</option>
              </select>
            </label>
            {!isDebtPayoff && (
              <label>
                Target amount
                <input
                  type="number"
                  step="0.01"
                  value={targetAmount}
                  onChange={(e) => setTargetAmount(e.target.value === "" ? "" : Number(e.target.value))}
                />
              </label>
            )}
            <label>
              Target date (optional)
              <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
            </label>
          </div>

          {isDebtPayoff && (
            <div className="field-row">
              <label>
                Strategy
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                  <option value="Snowball">Snowball (smallest balance first)</option>
                  <option value="Avalanche">Avalanche (highest interest first)</option>
                </select>
              </label>
              <label>
                Total monthly payment budget (optional, for multi-debt)
                <input type="number" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value === "" ? "" : Number(e.target.value))} />
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
            {submitting ? "Adding…" : "Add goal"}
          </button>
        </form>
      </section>
    </div>
  );
}
