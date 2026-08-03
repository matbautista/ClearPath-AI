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
  // Savings/Investment Transfer excluded.
  const categoryRows = db
    .prepare(
      `SELECT sc.name as category, SUM(
         CASE WHEN t.txn_type IN ('LoanPayment','CardPayment') THEN t.interest_portion_minor ELSE t.amount_minor END
       ) as total_minor
       FROM transactions t
       JOIN spending_categories sc ON sc.id = t.spending_category_id
       WHERE t.status = 'Posted' AND t.indicator = 'Debit' AND t.txn_date BETWEEN ? AND ?
         AND sc.name NOT IN ('Internal Transfer', 'Savings/Investment Transfer')
       GROUP BY sc.name
       ORDER BY total_minor DESC`
    )
    .all(periodStart, today) as { category: string; total_minor: number }[];
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

  const apiKey = decrypt(Buffer.from(settingsRow.ai_api_key_encrypted));
  const payload = buildPayload();

  let outputText: string;
  try {
    outputText = await callAnthropic(apiKey, payload);
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? err.message : (err as Error).message;
    db.prepare(`INSERT INTO ai_analysis_runs (status, error_message) VALUES ('Failed', ?)`).run(message);
    throw new Error(message);
  }

  db.prepare(`INSERT INTO ai_analysis_runs (status, output_text) VALUES ('Success', ?)`).run(outputText);
  db.prepare(`UPDATE settings SET ai_last_call_at = datetime('now'), ai_call_count = ai_call_count + 1 WHERE id = 1`).run();
  return { outputText };
}
