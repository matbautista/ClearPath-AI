// AI Analysis (3.11): builds a scrubbed, aggregated view of the user's
// finances and sends it to their own BYOK Claude API key for a written
// analysis. Data minimization (3.11): only account-type balances,
// category-level spending totals, goal progress, and pre-detected
// money-pit flags leave the server — never account numbers, institution
// names, or raw transaction descriptions. The one deliberate exception is
// money_pit_flags.cluster_description, which is a short curated label
// (like a category name) rather than arbitrary free text — without it the
// AI can't say *which* recurring-charge cluster it means.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db.js";
import { decrypt } from "./encryption.js";
import { computeAccountTypeTotals, computeSavingsRate } from "./dashboardEngine.js";
import { computeGoalProgress } from "./goalEngine.js";
import { todayUTC, addDaysUTC } from "./dateMath.js";
import { advanceCycle } from "./recurringEngine.js";

export class AiNotConfiguredError extends Error {}

interface AnalysisPayload {
  accountBalancesByType: Record<string, number>;
  savingsRate: { periodDays: number; incomeMinor: number; expenseMinor: number; rate: number | null };
  categorySpending: { category: string; totalMinor: number }[];
  goals: { goalType: string; status: string; currentAmountMinor: number; targetAmountMinor: number; targetDate: string | null }[];
  moneyPitFlags: { flagType: string; label: string; metric: unknown; utilizationNote: string | null }[];
}

function buildPayload(): AnalysisPayload {
  const accountBalancesByType = computeAccountTypeTotals();

  const today = todayUTC();
  const periodStart = addDaysUTC(today, -30);
  const savingsRateRaw = computeSavingsRate(periodStart, today);
  const savingsRate = { periodDays: 30, ...savingsRateRaw };

  // Same category-total computation as Category Trend Detection / Savings
  // Rate (2.4/3.1/3.11a, see schema.sql's reference query) — Debit leg
  // only, Interest Portion for debt payments, Internal Transfer and
  // Savings/Investment Transfer excluded. Additional Fees are unioned in
  // separately, always attributed to 'Taxes/Fees' regardless of the
  // transaction's own category (2.5 — "shows up... in the AI analysis as
  // its own line item") — excluding a transfer's own category must not
  // also exclude its fee, which is real spending, not part of the transfer.
  const categoryRows = db
    .prepare(
      `SELECT category, SUM(amt) as total_minor FROM (
         SELECT sc.name as category,
                CASE WHEN t.txn_type IN ('LoanPayment','CardPayment') THEN t.interest_portion_minor ELSE t.amount_minor END as amt
         FROM transactions t
         JOIN spending_categories sc ON sc.id = t.spending_category_id
         WHERE t.status = 'Posted' AND t.indicator = 'Debit' AND t.txn_date BETWEEN ? AND ?
           AND sc.name NOT IN ('Internal Transfer', 'Savings/Investment Transfer')
         UNION ALL
         SELECT 'Taxes/Fees' as category, t.additional_fees_minor as amt
         FROM transactions t
         WHERE t.status = 'Posted' AND t.indicator = 'Debit' AND t.additional_fees_minor > 0
           AND t.txn_date BETWEEN ? AND ?
       )
       GROUP BY category
       ORDER BY total_minor DESC`
    )
    .all(periodStart, today, periodStart, today) as { category: string; total_minor: number }[];
  const categorySpending = categoryRows.map((r) => ({ category: r.category, totalMinor: r.total_minor }));

  const goalRows = db
    .prepare(`SELECT id, goal_type, status, target_amount_minor, target_date FROM goals WHERE status != 'Abandoned'`)
    .all() as { id: number; goal_type: string; status: string; target_amount_minor: number; target_date: string | null }[];
  const goals = goalRows.map((g) => {
    const progress = computeGoalProgress(g.id);
    return {
      goalType: g.goal_type,
      status: g.status,
      currentAmountMinor: progress?.currentAmountMinor ?? 0,
      targetAmountMinor: g.goal_type === "DebtPayoff" ? 0 : g.target_amount_minor,
      targetDate: g.target_date,
    };
  });

  // Money-pit flags (3.11a) are pre-detected facts, narrated here rather
  // than re-derived by the AI.
  const flagRows = db
    .prepare(
      `SELECT mpf.flag_type, sc.name as category_name, mpf.cluster_description, mpf.metric_summary, mpf.utilization_note
       FROM money_pit_flags mpf
       LEFT JOIN spending_categories sc ON sc.id = mpf.spending_category_id
       WHERE mpf.status = 'Active'`
    )
    .all() as { flag_type: string; category_name: string | null; cluster_description: string | null; metric_summary: string | null; utilization_note: string | null }[];
  const moneyPitFlags = flagRows.map((r) => ({
    flagType: r.flag_type,
    label: r.category_name ?? r.cluster_description ?? "Unknown",
    metric: r.metric_summary ? JSON.parse(r.metric_summary) : null,
    utilizationNote: r.utilization_note,
  }));

  return { accountBalancesByType, savingsRate, categorySpending, goals, moneyPitFlags };
}

const SYSTEM_PROMPT = `You are the AI Analysis feature inside ClearPath AI, a self-hosted personal finance app. You receive an aggregated, scrubbed snapshot of the user's finances — never raw transactions, account numbers, or institution names — and produce a written analysis.

Structure your response with these sections, in this order:
1. Summary — income vs. expenses, savings rate, and debt-to-income for the period. Use the savingsRate figure given to you exactly as provided; do not recompute it yourself.
2. Goal plans — for each active goal in the data, a concrete, specific plan to reach it given its current progress and target.
3. Flags & alerts — call out unusual spending or any signs of an upcoming cash shortfall, based only on the data given.
4. Money-pit flags — narrate the provided moneyPitFlags list in plain language. These are already-detected facts from the app's own detection system; do not invent new ones or contradict them.
5. Patterns worth reviewing — your own hypotheses about spending patterns (e.g. possible subscription overlap, categories creeping up). Phrase every one of these as a suggestion to verify, never as a factual claim about usage or necessity — e.g. "you may want to check whether you still use all of these" rather than "you don't need this." You have no visibility into whether a expense is actually being used or valued.

Be concise and concrete. Use the user's base currency minor-unit amounts as given (already in the smallest currency unit, e.g. cents) — convert to major units in your prose (divide by 100) and do not display minor-unit figures directly.`;

async function callAnthropic(apiKey: string, payload: AnalysisPayload): Promise<string> {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model: "claude-opus-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    },
    { timeout: 30_000 }
  );
  if (response.stop_reason === "refusal") {
    throw new Error("The AI provider declined to produce this analysis.");
  }
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!textBlock) throw new Error("The AI provider returned no text output.");
  return textBlock.text;
}

// On-demand trigger (3.11 — "Analyze my finances now"). Graceful failure
// only: no silent retry, no fabricated fallback output on error — a
// Failed run is recorded with the real error message.
export async function runAiAnalysis(): Promise<{ outputText: string }> {
  const settingsRow = db.prepare("SELECT * FROM settings WHERE id = 1").get() as
    | { ai_analysis_enabled: number; ai_api_key_encrypted: Uint8Array | null; ai_provider: string | null }
    | undefined;
  if (!settingsRow || !settingsRow.ai_analysis_enabled) {
    throw new AiNotConfiguredError("AI Analysis is not enabled. Turn it on in Settings first.");
  }
  if (!settingsRow.ai_api_key_encrypted || !settingsRow.ai_provider) {
    throw new AiNotConfiguredError("No AI provider or API key is configured. Add one in Settings first.");
  }

  let outputText: string;
  try {
    // decrypt()/buildPayload() are inside this try too (not just
    // callAnthropic) — a stale/rotated data/master.key throws here (AES-GCM
    // auth-tag mismatch), and that failure needs recording exactly like an
    // API failure, matching this function's own "a Failed run is recorded
    // with the real error message" contract above.
    const apiKey = decrypt(Buffer.from(settingsRow.ai_api_key_encrypted));
    const payload = buildPayload();
    outputText = await callAnthropic(apiKey, payload);
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? err.message : (err as Error).message;
    db.prepare(`INSERT INTO ai_analysis_runs (status, error_message) VALUES ('Failed', ?)`).run(message);
    throw new Error(message);
  }

  db.prepare(`INSERT INTO ai_analysis_runs (status, output_text) VALUES ('Success', ?)`).run(outputText);
  db.prepare(`UPDATE settings SET ai_last_call_at = datetime('now'), ai_call_count = ai_call_count + 1 WHERE id = 1`).run();
  advanceScheduleIfDue();
  return { outputText };
}

// If a scheduled run was due, this run fulfills it (3.11) — regardless of
// whether it was triggered by the Dashboard's one-tap prompt or an
// on-demand "Analyze my finances now" click. Either way the user has
// current analysis for this period, so there's no need to also prompt
// them again until next month. Only advances a date that's actually due;
// never touches a schedule that isn't due yet, and never advances on a
// Failed run (handled by the caller, above) — a failure should stay due
// and retry, not be silently marked done.
function advanceScheduleIfDue() {
  const row = db.prepare("SELECT ai_next_scheduled_run_date FROM settings WHERE id = 1").get() as
    | { ai_next_scheduled_run_date: string | null }
    | undefined;
  if (!row?.ai_next_scheduled_run_date) return;
  const today = todayUTC();
  if (row.ai_next_scheduled_run_date > today) return;
  let next = row.ai_next_scheduled_run_date;
  while (next <= today) next = advanceCycle(next, "Monthly");
  db.prepare("UPDATE settings SET ai_next_scheduled_run_date = ? WHERE id = 1").run(next);
}

interface ScheduleRow {
  ai_analysis_enabled: number;
  ai_scheduled_auto_run: number;
  ai_next_scheduled_run_date: string | null;
}

function getScheduleRow(): ScheduleRow | undefined {
  return db
    .prepare("SELECT ai_analysis_enabled, ai_scheduled_auto_run, ai_next_scheduled_run_date FROM settings WHERE id = 1")
    .get() as ScheduleRow | undefined;
}

// Dashboard-facing check (3.11): true only when a schedule is due AND the
// user did NOT opt into full auto-run — that's exactly the "surfaces as a
// one-tap prompt" default path. When auto-run is on, checkScheduledAiAnalysis
// (below) handles it silently instead, so there's nothing to prompt for.
export function isScheduledAiAnalysisDue(): boolean {
  const row = getScheduleRow();
  if (!row || !row.ai_analysis_enabled || row.ai_scheduled_auto_run || !row.ai_next_scheduled_run_date) return false;
  return row.ai_next_scheduled_run_date <= todayUTC();
}

// Background job (index.ts) — same "check on boot + hourly" pattern as
// runDueRecurringRules (2.7). Only acts when the user explicitly opted
// into ai_scheduled_auto_run; otherwise this is a no-op and the schedule
// just stays due for isScheduledAiAnalysisDue/the Dashboard prompt above.
export async function checkScheduledAiAnalysis(): Promise<void> {
  const row = getScheduleRow();
  if (!row || !row.ai_analysis_enabled || !row.ai_scheduled_auto_run || !row.ai_next_scheduled_run_date) return;
  if (row.ai_next_scheduled_run_date > todayUTC()) return;
  try {
    await runAiAnalysis();
  } catch {
    // Already recorded as a Failed run inside runAiAnalysis — nothing
    // further to do; the schedule stays due and retries next check.
  }
}
