import { useEffect, useState } from "react";
import { api, type DashboardSummary, type NetWorthTrendPoint, type SavingsRateResult, type Goal, type MoneyPitFlag } from "../api";
import { formatMinor } from "../lib/money";
import { useSettings } from "../SettingsContext";
import { NetWorthChart } from "../components/NetWorthChart";

const GOAL_TYPE_LABELS: Record<Goal["goalType"], string> = {
  DebtPayoff: "Debt Payoff",
  EmergencyFund: "Emergency Fund",
  SavingsTarget: "Savings Target",
  InvestmentTarget: "Investment Target",
};

const DUE_SOURCE_LABELS: Record<string, string> = {
  Loan: "Loan",
  CreditCard: "Credit Card",
  Utility: "Utility",
  TaxFee: "Tax/Fee",
};

function StatTile({ label, valueMinor, currency, emphasis }: { label: string; valueMinor: number; currency: string; emphasis?: boolean }) {
  return (
    <div className={`stat-tile${emphasis ? " stat-tile-emphasis" : ""}`}>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{formatMinor(valueMinor, currency)}</div>
    </div>
  );
}

function MoneyPitCard({ flag, currency, onDismiss }: { flag: MoneyPitFlag; currency: string; onDismiss: () => void }) {
  const m = flag.metric;
  return (
    <li className="money-pit-item">
      <div className="money-pit-body">
        {flag.flagType === "CategoryTrend" ? (
          <>
            <strong>{flag.spendingCategoryName}</strong> is up {m?.growthPct}% this month —{" "}
            {formatMinor(m?.currentMonthMinor ?? 0, currency)} vs. a {formatMinor(m?.trailingAvgMinor ?? 0, currency)} trailing average.
          </>
        ) : (
          <>
            <strong>{flag.clusterDescription}</strong>: {m?.occurrenceCount} charges of ~{formatMinor(m?.avgAmountMinor ?? 0, currency)} each,
            about {formatMinor(m?.monthlyEquivalentMinor ?? 0, currency)}/month.
            {flag.utilizationNote && <div className="muted">Note: {flag.utilizationNote}</div>}
          </>
        )}
      </div>
      <button type="button" className="secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </li>
  );
}

export function DashboardPage() {
  const { baseCurrency } = useSettings();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [trend, setTrend] = useState<NetWorthTrendPoint[]>([]);
  const [savingsRate, setSavingsRate] = useState<SavingsRateResult | null>(null);
  const [savingsPeriod, setSavingsPeriod] = useState<30 | 90>(30);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [moneyPits, setMoneyPits] = useState<MoneyPitFlag[]>([]);
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    Promise.all([api.dashboardSummary(), api.netWorthTrend(90), api.savingsRate(savingsPeriod), api.listGoals(), api.listMoneyPits()])
      .then(([s, t, sr, g, mp]) => {
        setSummary(s);
        setTrend(t);
        setSavingsRate(sr);
        setGoals(g.filter((goal) => goal.status === "Active"));
        setMoneyPits(mp);
      })
      .finally(() => setLoading(false));
  }

  async function dismissMoneyPit(id: number) {
    await api.dismissMoneyPit(id);
    setMoneyPits((prev) => prev.filter((f) => f.id !== id));
  }

  useEffect(loadAll, [savingsPeriod]);

  if (loading || !summary) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-subtitle">How much you have, what's due soon, and whether you're saving — without needing AI Analysis enabled (3.1).</p>
      </header>

      <div className="stat-tile-row">
        <StatTile label="Cash on Hand" valueMinor={summary.cashOnHandMinor} currency={baseCurrency} />
        <StatTile label="Cash in Bank" valueMinor={summary.totalCashInBankMinor} currency={baseCurrency} />
        <StatTile label="E-Wallets" valueMinor={summary.totalEWalletMinor} currency={baseCurrency} />
        <StatTile label="Investments" valueMinor={summary.totalInvestmentValueMinor} currency={baseCurrency} />
        <StatTile label="Loan Balance" valueMinor={summary.totalLoanBalanceMinor} currency={baseCurrency} />
        <StatTile label="Card Balance" valueMinor={summary.totalCardBalanceMinor} currency={baseCurrency} />
        <StatTile label="Net Worth" valueMinor={summary.netWorthMinor} currency={baseCurrency} emphasis />
      </div>

      <section>
        <h2>Net worth trend</h2>
        <NetWorthChart points={trend} currency={baseCurrency} />
      </section>

      <div className="dashboard-columns">
        <section>
          <div className="section-header-row">
            <h2>Savings rate</h2>
            <div className="period-toggle">
              <button className={savingsPeriod === 30 ? "nav-active" : "nav-link"} onClick={() => setSavingsPeriod(30)}>
                30d
              </button>
              <button className={savingsPeriod === 90 ? "nav-active" : "nav-link"} onClick={() => setSavingsPeriod(90)}>
                90d
              </button>
            </div>
          </div>
          {savingsRate && savingsRate.rate == null ? (
            <p className="muted">Not enough income data for this period.</p>
          ) : (
            savingsRate && (
              <>
                <div className="savings-rate-figure">{(savingsRate.rate! * 100).toFixed(1)}%</div>
                <p className="muted">
                  {formatMinor(savingsRate.incomeMinor, baseCurrency)} in ·{" "}
                  {formatMinor(savingsRate.expenseMinor, baseCurrency)} spent, last {savingsRate.periodDays} days
                </p>
              </>
            )
          )}
        </section>

        <section>
          <h2>Upcoming dues (30 days)</h2>
          {summary.upcomingDues.length === 0 ? (
            <p className="muted">Nothing due in the next 30 days.</p>
          ) : (
            <ul className="upcoming-dues-list">
              {summary.upcomingDues.map((d, i) => (
                <li key={i}>
                  <span>{d.label}</span>
                  <span className="muted">{DUE_SOURCE_LABELS[d.source]}</span>
                  <span className="muted">{d.dueDate}</span>
                  <span className="numeric">{formatMinor(d.amountMinor, baseCurrency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="dashboard-columns">
        <section>
          <h2>Money-pit flags</h2>
          {moneyPits.length === 0 ? (
            <p className="muted">
              Nothing flagged right now. Category trends need ~3 months of history; charges need to repeat at least 3 times before they cluster (3.11a).
            </p>
          ) : (
            <ul className="money-pit-list">
              {moneyPits.map((f) => (
                <MoneyPitCard key={f.id} flag={f} currency={baseCurrency} onDismiss={() => dismissMoneyPit(f.id)} />
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Active goals</h2>
          {goals.length === 0 ? (
            <p className="muted">No active goals.</p>
          ) : (
            <ul className="dashboard-goals-list">
              {goals.map((g) => {
                const pct =
                  g.goalType === "DebtPayoff"
                    ? 0
                    : g.targetAmountMinor > 0
                      ? Math.min(100, Math.round((g.currentAmountMinor / g.targetAmountMinor) * 100))
                      : 0;
                return (
                  <li key={g.id}>
                    <div className="dashboard-goal-header">
                      <span>{GOAL_TYPE_LABELS[g.goalType]}</span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
