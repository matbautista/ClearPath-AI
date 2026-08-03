import { useEffect, useState } from "react";
import { api, ApiError, type AiAnalysisRun } from "../api";
import { useSettings } from "../SettingsContext";

// AI Analysis (3.11): on-demand trigger ("Analyze my finances now") plus
// a history of past runs. The confirm() dialog before triggering is the
// spec's "visible indicator whenever data is sent externally" — the user
// explicitly acknowledges the send each time, not just once at setup.
export function AiAssistPage() {
  const settings = useSettings();
  const [runs, setRuns] = useState<AiAnalysisRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadRuns() {
    setLoading(true);
    api
      .listAiRuns()
      .then(setRuns)
      .finally(() => setLoading(false));
  }

  useEffect(loadRuns, []);

  async function handleRun() {
    if (
      !confirm(
        "This sends a scrubbed summary of your account balances, category spending totals, goal progress, and money-pit flags to your configured AI provider. No account numbers, institution names, or transaction descriptions are included. Continue?"
      )
    ) {
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await api.runAiAnalysis();
      loadRuns();
    } catch (err) {
      setError(err instanceof ApiError ? err.errors.join(" ") : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  const latest = runs[0];

  return (
    <div className="page">
      <header className="page-header">
        <h1>AI Assist</h1>
        <p className="page-subtitle">
          Written summary, per-goal plans, spending flags, and money-pit narration from your own
          BYOK AI provider (3.11). Pattern-based suggestions are always hypotheses to verify, never
          claims about how you actually use something.
        </p>
      </header>

      {!settings.aiAnalysisEnabled ? (
        <p className="muted">AI Analysis isn't enabled yet. Turn it on and add an API key in Settings first.</p>
      ) : (
        <>
          <section className="new-transaction-form">
            <button type="button" onClick={handleRun} disabled={running}>
              {running ? "Analyzing…" : "Analyze my finances now"}
            </button>
            {error && (
              <ul className="form-errors">
                <li>{error}</li>
              </ul>
            )}
          </section>

          <section className="transactions-list">
            {loading ? (
              <p className="muted">Loading…</p>
            ) : runs.length === 0 ? (
              <p className="muted">No analysis has been run yet.</p>
            ) : (
              <>
                <h2>Latest result</h2>
                {latest.status === "Failed" ? (
                  <p className="form-errors">{latest.errorMessage}</p>
                ) : (
                  <pre className="ai-output">{latest.outputText}</pre>
                )}

                <h2>History</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Ran at</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id}>
                        <td>{r.ranAt}</td>
                        <td>
                          <span className={`status-pill status-${r.status.toLowerCase()}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
