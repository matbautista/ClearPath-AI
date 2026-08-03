import { Router } from "express";
import { db } from "../db.js";
import { runMoneyPitDetection } from "../lib/moneyPitEngine.js";

export const moneyPitsRouter = Router();

moneyPitsRouter.get("/", (req, res) => {
  const status = req.query.status === "Dismissed" ? "Dismissed" : "Active";
  const rows = db
    .prepare(
      `SELECT mpf.*, sc.name as spending_category_name
       FROM money_pit_flags mpf
       LEFT JOIN spending_categories sc ON sc.id = mpf.spending_category_id
       WHERE mpf.status = ?
       ORDER BY mpf.detected_at DESC`
    )
    .all(status) as any[];

  res.json(
    rows.map((r) => ({
      id: r.id,
      flagType: r.flag_type,
      spendingCategoryName: r.spending_category_name,
      clusterDescription: r.cluster_description,
      metric: r.metric_summary ? JSON.parse(r.metric_summary) : null,
      utilizationNote: r.utilization_note,
      status: r.status,
      detectedAt: r.detected_at,
      dismissedAt: r.dismissed_at,
    }))
  );
});

moneyPitsRouter.post("/:id/dismiss", (req, res) => {
  const info = db
    .prepare(`UPDATE money_pit_flags SET status = 'Dismissed', dismissed_at = datetime('now') WHERE id = ? AND status = 'Active'`)
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ errors: ["Active flag not found."] });
  res.json({ ok: true });
});

// Manual utilization note (3.11a) — the one way a user can tell the
// engine "I know this looks like a money pit, but here's the context,"
// since the engine itself has no usage data to judge that on its own.
moneyPitsRouter.post("/:id/utilization-note", (req, res) => {
  const { note } = req.body as { note?: string };
  const info = db.prepare(`UPDATE money_pit_flags SET utilization_note = ? WHERE id = ?`).run(note ?? null, req.params.id);
  if (info.changes === 0) return res.status(404).json({ errors: ["Flag not found."] });
  res.json({ ok: true });
});

// Manual trigger for dev/testing — normally runs on server startup and
// hourly thereafter alongside the other background jobs (index.ts).
moneyPitsRouter.post("/run", (_req, res) => {
  res.json(runMoneyPitDetection());
});
