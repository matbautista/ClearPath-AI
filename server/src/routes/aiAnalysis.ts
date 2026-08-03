import { Router } from "express";
import { db } from "../db.js";
import { runAiAnalysis, AiNotConfiguredError } from "../lib/aiAnalysisEngine.js";

export const aiAnalysisRouter = Router();

// On-demand trigger (3.11 — "Analyze my finances now"). Visible
// externally-sent-data indicator: the client shows a confirmation before
// calling this, since a live run means the scrubbed data payload leaves
// the server for the configured provider.
aiAnalysisRouter.post("/run", async (_req, res) => {
  try {
    const { outputText } = await runAiAnalysis();
    res.json({ outputText });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      return res.status(422).json({ errors: [err.message] });
    }
    // Failure/cost handling (3.11): report the real error, no fabricated
    // output, no silent retry — the run is already recorded as Failed by
    // runAiAnalysis before this catch.
    res.status(502).json({ errors: [(err as Error).message] });
  }
});

aiAnalysisRouter.get("/runs", (_req, res) => {
  const rows = db
    .prepare(`SELECT id, ran_at, status, output_text, error_message FROM ai_analysis_runs ORDER BY ran_at DESC LIMIT 20`)
    .all() as { id: number; ran_at: string; status: string; output_text: string | null; error_message: string | null }[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      ranAt: r.ran_at,
      status: r.status,
      outputText: r.output_text,
      errorMessage: r.error_message,
    }))
  );
});
