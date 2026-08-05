// Spending Pattern Detection / "Money Pits" (3.11a) — runs entirely on
// the app's own transaction data, no external API. Two detectors:
// Category Trend (a Spending Category growing vs. its own trailing
// average) and Recurring-Charge Clustering (repeated same-description
// charges, e.g. subscriptions). Both are strictly fact-based: cost and
// frequency only, never a claim about whether something is "worth it"
// (3.11a is explicit that the engine has no usage data to judge that).
import { db } from "./../db.js";
import { addDaysUTC, todayUTC } from "./dateMath.js";

const CATEGORY_TREND_GROWTH_THRESHOLD = 1.3; // 30%+ over trailing average
const CLUSTER_MIN_OCCURRENCES = 3;
const HISTORY_REQUIRED_DAYS = 90; // "roughly 3 months" (3.11a)
const CLUSTER_LOOKBACK_DAYS = 180;

function excludedCategoryIds(): number[] {
  return (
    db.prepare("SELECT id FROM spending_categories WHERE name IN ('Internal Transfer', 'Savings/Investment Transfer')").all() as {
      id: number;
    }[]
  ).map((r) => r.id);
}

function hasEnoughHistory(): boolean {
  const earliest = db.prepare("SELECT MIN(txn_date) as d FROM transactions WHERE status = 'Posted'").get() as { d: string | null };
  if (!earliest.d) return false;
  return earliest.d <= addDaysUTC(todayUTC(), -HISTORY_REQUIRED_DAYS);
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

function shiftMonthKey(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + delta;
  const newY = Math.floor(total / 12);
  const newM = (total % 12) + 1;
  return `${newY}-${String(newM).padStart(2, "0")}`;
}

// --- Category Trend Detection -------------------------------------------

interface CategoryTrendResult {
  categoryId: number;
  currentMonthMinor: number;
  trailingAvgMinor: number;
  growthPct: number;
}

function detectCategoryTrends(): CategoryTrendResult[] {
  const excluded = excludedCategoryIds();
  const currentMonth = monthKey(todayUTC());
  const lookbackStart = shiftMonthKey(currentMonth, -3) + "-01";

  // Additional Fees are unioned in separately, always attributed to
  // 'Taxes/Fees' regardless of the transaction's own category (2.5 — a
  // transfer's own category, e.g. Internal Transfer, is excluded below,
  // but its fee is still real spending, not part of the transfer). Same
  // pattern as dashboardEngine.ts's computeSavingsRate and
  // aiAnalysisEngine.ts's buildPayload — see schema.sql's reference query.
  const rows = db
    .prepare(
      `SELECT categoryId, ym, SUM(amt) as total FROM (
         SELECT spending_category_id as categoryId, strftime('%Y-%m', txn_date) as ym,
                CASE WHEN txn_type IN ('LoanPayment','CardPayment') THEN interest_portion_minor ELSE amount_minor END as amt
         FROM transactions
         WHERE status = 'Posted' AND indicator = 'Debit' AND spending_category_id IS NOT NULL
           AND txn_date >= ?
         UNION ALL
         SELECT (SELECT id FROM spending_categories WHERE name = 'Taxes/Fees') as categoryId,
                strftime('%Y-%m', txn_date) as ym, additional_fees_minor as amt
         FROM transactions
         WHERE status = 'Posted' AND indicator = 'Debit' AND additional_fees_minor > 0
           AND txn_date >= ?
       )
       GROUP BY categoryId, ym`
    )
    .all(lookbackStart, lookbackStart) as { categoryId: number; ym: string; total: number }[];

  const byCategory = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (excluded.includes(r.categoryId)) continue;
    if (!byCategory.has(r.categoryId)) byCategory.set(r.categoryId, new Map());
    byCategory.get(r.categoryId)!.set(r.ym, r.total);
  }

  const results: CategoryTrendResult[] = [];
  for (const [categoryId, months] of byCategory) {
    const currentMonthMinor = months.get(currentMonth) ?? 0;
    const trailingMonths = [1, 2, 3].map((n) => months.get(shiftMonthKey(currentMonth, -n)) ?? 0);
    const trailingAvgMinor = trailingMonths.reduce((a, b) => a + b, 0) / 3;
    if (trailingAvgMinor <= 0 || currentMonthMinor <= 0) continue;
    const growthPct = ((currentMonthMinor - trailingAvgMinor) / trailingAvgMinor) * 100;
    if (currentMonthMinor >= trailingAvgMinor * CATEGORY_TREND_GROWTH_THRESHOLD) {
      results.push({ categoryId, currentMonthMinor, trailingAvgMinor, growthPct });
    }
  }
  return results;
}

function upsertCategoryTrendFlags(results: CategoryTrendResult[]) {
  const currentIds = results.map((r) => r.categoryId);

  // Auto-resolve: an Active flag whose category no longer trends gets
  // removed — it was never a user decision (dismissal), just a stale
  // fact, the same "derived, not a stored one-way state" principle
  // already used for Goal Status (2.8) and Available Balance (2.1).
  if (currentIds.length > 0) {
    const placeholders = currentIds.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM money_pit_flags WHERE flag_type = 'CategoryTrend' AND status = 'Active' AND spending_category_id NOT IN (${placeholders})`
    ).run(...currentIds);
  } else {
    db.prepare(`DELETE FROM money_pit_flags WHERE flag_type = 'CategoryTrend' AND status = 'Active'`).run();
  }

  const currentMonth = monthKey(todayUTC());

  for (const r of results) {
    const metric = JSON.stringify({
      growthPct: Math.round(r.growthPct),
      currentMonthMinor: r.currentMonthMinor,
      trailingAvgMinor: Math.round(r.trailingAvgMinor),
    });

    // Most recent row for this category, any status — governs whether we
    // update an Active flag, insert a fresh one, or stay quiet.
    const lastRow = db
      .prepare(
        `SELECT id, status, detected_at FROM money_pit_flags WHERE flag_type = 'CategoryTrend' AND spending_category_id = ?
         ORDER BY detected_at DESC LIMIT 1`
      )
      .get(r.categoryId) as { id: number; status: string; detected_at: string } | undefined;

    if (lastRow?.status === "Active") {
      db.prepare(`UPDATE money_pit_flags SET metric_summary = ?, detected_at = datetime('now') WHERE id = ?`).run(metric, lastRow.id);
      continue;
    }

    // Dismissed and still the same month it was dismissed in: the trend
    // being "still true" isn't new evidence — the user already saw this
    // month's number and dismissed it. Re-detection creating a new flag
    // is for genuinely later evidence, not the same data re-triggering
    // on the next hourly run (2.8-style dismissal semantics, schema.sql).
    if (lastRow?.status === "Dismissed" && monthKey(lastRow.detected_at) === currentMonth) continue;

    db.prepare(
      `INSERT INTO money_pit_flags (flag_type, spending_category_id, metric_summary, status) VALUES ('CategoryTrend', ?, ?, 'Active')`
    ).run(r.categoryId, metric);
  }
}

// --- Recurring-Charge Clustering ------------------------------------------

interface ClusterResult {
  clusterKey: string;
  description: string;
  transactionIds: number[];
  occurrenceCount: number;
  avgAmountMinor: number;
  monthlyEquivalentMinor: number;
}

function normalizeDescription(desc: string): string {
  return desc.trim().toLowerCase().replace(/\s+/g, " ");
}

function detectRecurringClusters(): ClusterResult[] {
  const since = addDaysUTC(todayUTC(), -CLUSTER_LOOKBACK_DAYS);
  const rows = db
    .prepare(
      `SELECT id, description, amount_minor, txn_date
       FROM transactions
       WHERE status = 'Posted' AND indicator = 'Debit' AND description IS NOT NULL AND TRIM(description) != ''
         AND txn_date >= ?
       ORDER BY txn_date`
    )
    .all(since) as { id: number; description: string; amount_minor: number; txn_date: string }[];

  const groups = new Map<string, { description: string; ids: number[]; amounts: number[]; dates: string[] }>();
  for (const r of rows) {
    const key = normalizeDescription(r.description);
    if (!groups.has(key)) groups.set(key, { description: r.description, ids: [], amounts: [], dates: [] });
    const g = groups.get(key)!;
    g.ids.push(r.id);
    g.amounts.push(r.amount_minor);
    g.dates.push(r.txn_date);
  }

  const results: ClusterResult[] = [];
  for (const [key, g] of groups) {
    if (g.ids.length < CLUSTER_MIN_OCCURRENCES) continue;
    const total = g.amounts.reduce((a, b) => a + b, 0);
    const avgAmountMinor = Math.round(total / g.ids.length);
    const spanDays = Math.max(1, (new Date(g.dates[g.dates.length - 1]).getTime() - new Date(g.dates[0]).getTime()) / 86400000);
    const monthsSpanned = Math.max(1, spanDays / 30);
    const monthlyEquivalentMinor = Math.round(total / monthsSpanned);
    results.push({
      clusterKey: key,
      description: g.description,
      transactionIds: g.ids,
      occurrenceCount: g.ids.length,
      avgAmountMinor,
      monthlyEquivalentMinor,
    });
  }
  return results;
}

function upsertClusterFlags(results: ClusterResult[]) {
  const currentKeys = results.map((r) => r.clusterKey);

  if (currentKeys.length > 0) {
    const placeholders = currentKeys.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM money_pit_flags WHERE flag_type = 'RecurringChargeCluster' AND status = 'Active' AND cluster_key NOT IN (${placeholders})`
    ).run(...currentKeys);
  } else {
    db.prepare(`DELETE FROM money_pit_flags WHERE flag_type = 'RecurringChargeCluster' AND status = 'Active'`).run();
  }

  for (const r of results) {
    const metric = JSON.stringify({
      occurrenceCount: r.occurrenceCount,
      avgAmountMinor: r.avgAmountMinor,
      monthlyEquivalentMinor: r.monthlyEquivalentMinor,
    });

    const lastRow = db
      .prepare(
        `SELECT id, status FROM money_pit_flags WHERE flag_type = 'RecurringChargeCluster' AND cluster_key = ?
         ORDER BY detected_at DESC LIMIT 1`
      )
      .get(r.clusterKey) as { id: number; status: string } | undefined;

    if (lastRow?.status === "Active") {
      db.prepare(`UPDATE money_pit_flags SET metric_summary = ?, cluster_description = ?, detected_at = datetime('now') WHERE id = ?`).run(
        metric,
        r.description,
        lastRow.id
      );
      db.prepare(`DELETE FROM money_pit_flag_transactions WHERE flag_id = ?`).run(lastRow.id);
      const insertMember = db.prepare(`INSERT OR IGNORE INTO money_pit_flag_transactions (flag_id, transaction_id) VALUES (?, ?)`);
      for (const txnId of r.transactionIds) insertMember.run(lastRow.id, txnId);
      continue;
    }

    if (lastRow?.status === "Dismissed") {
      // Only new evidence — a transaction the dismissed flag never saw —
      // justifies a fresh flag. The same charges still being there isn't
      // new evidence; that's just the dismissal working as intended.
      const alreadySeen = new Set(
        (db.prepare(`SELECT transaction_id FROM money_pit_flag_transactions WHERE flag_id = ?`).all(lastRow.id) as { transaction_id: number }[]).map(
          (row) => row.transaction_id
        )
      );
      const hasNewEvidence = r.transactionIds.some((id) => !alreadySeen.has(id));
      if (!hasNewEvidence) continue;
    }

    const flagId = Number(
      db
        .prepare(
          `INSERT INTO money_pit_flags (flag_type, cluster_key, cluster_description, metric_summary, status)
           VALUES ('RecurringChargeCluster', ?, ?, ?, 'Active')`
        )
        .run(r.clusterKey, r.description, metric).lastInsertRowid
    );
    const insertMember = db.prepare(`INSERT OR IGNORE INTO money_pit_flag_transactions (flag_id, transaction_id) VALUES (?, ?)`);
    for (const txnId of r.transactionIds) insertMember.run(flagId, txnId);
  }
}

export function runMoneyPitDetection(): { categoryFlags: number; clusterFlags: number; skipped: boolean } {
  if (!hasEnoughHistory()) return { categoryFlags: 0, clusterFlags: 0, skipped: true };

  const trends = detectCategoryTrends();
  upsertCategoryTrendFlags(trends);

  const clusters = detectRecurringClusters();
  upsertClusterFlags(clusters);

  return { categoryFlags: trends.length, clusterFlags: clusters.length, skipped: false };
}
