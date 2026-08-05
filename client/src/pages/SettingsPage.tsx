import { useState } from "react";
import { api, ApiError } from "../api";
import { useSettings } from "../SettingsContext";

// AI Analysis configuration (3.11): explicit opt-in, BYOK API key (never
// echoed back by the server — this form never shows the current key,
// only whether one is configured), and the scheduled-auto-run opt-in
// (off by default — a "ready to run" prompt is the default behavior,
// full auto-run is a separate, explicit choice per the spec).
export function SettingsPage() {
  const settings = useSettings();
  const [aiAnalysisEnabled, setAiAnalysisEnabled] = useState(settings.aiAnalysisEnabled);
  const [aiProvider, setAiProvider] = useState(settings.aiProvider ?? "Anthropic");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiScheduledAutoRun, setAiScheduledAutoRun] = useState(settings.aiScheduledAutoRun);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetPassphrase, setResetPassphrase] = useState("");
  const [resetErrors, setResetErrors] = useState<string[]>([]);
  const [resetting, setResetting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors([]);
    setSaved(false);
    try {
      await api.updateAiSettings({
        aiAnalysisEnabled,
        aiProvider,
        aiApiKey: aiApiKey === "" ? undefined : aiApiKey,
        aiScheduledAutoRun,
      });
      setAiApiKey("");
      setSaved(true);
      // A fresh fetch of /me on next app load will pick up the change;
      // this page's local state already reflects what was just saved.
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setResetting(true);
    setResetErrors([]);
    try {
      await api.resetDatabase(resetPassphrase);
      // Settings row is gone server-side, so a full reload is the simplest
      // way back to a clean app state — App.tsx's status check will land
      // on the Setup page on its own, same as any other fresh instance.
      window.location.reload();
    } catch (err) {
      setResetErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
      setResetting(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">
          Base Currency is fixed after setup (4.2). AI Analysis is opt-in and uses your own API
          key (BYOK) — nothing is sent externally unless you enable it below (3.11).
        </p>
      </header>

      <section className="new-transaction-form">
        <h2>Base Currency</h2>
        <p className="muted">{settings.baseCurrency}</p>
      </section>

      <section className="new-transaction-form">
        <h2>AI Analysis</h2>
        <form onSubmit={handleSave}>
          <div className="field-row">
            <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
              <input type="checkbox" checked={aiAnalysisEnabled} onChange={(e) => setAiAnalysisEnabled(e.target.checked)} />
              Enable AI Analysis
            </label>
          </div>

          <div className="field-row">
            <label>
              Provider
              <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                <option value="Anthropic">Anthropic</option>
              </select>
            </label>
            <label>
              API key {settings.aiProvider && <span className="muted">(configured — leave blank to keep it)</span>}
              <input
                type="password"
                value={aiApiKey}
                onChange={(e) => setAiApiKey(e.target.value)}
                placeholder={settings.aiProvider ? "Leave blank to keep current key" : "sk-ant-..."}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="field-row">
            <label style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
              <input type="checkbox" checked={aiScheduledAutoRun} onChange={(e) => setAiScheduledAutoRun(e.target.checked)} />
              Run automatically on schedule (otherwise you'll get a one-tap prompt instead)
            </label>
          </div>

          <p className="muted">
            Last call: {settings.aiLastCallAt ?? "never"} · Total calls: {settings.aiCallCount}
          </p>

          {errors.length > 0 && (
            <ul className="form-errors">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
          {saved && <p className="muted">Saved. Reload the page to see updated status everywhere.</p>}

          <button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      </section>

      <section className="new-transaction-form danger-zone">
        <h2>Danger zone</h2>
        <p className="muted">
          Permanently deletes every account, transaction, goal, and recurring rule, and
          returns this instance to a blank pre-setup state — same as a brand-new install.
          Use this to start over, or to wipe this machine's copy before moving to another
          one (see DEPLOY.md). There is no undo — back up <code>data/clearpath.db</code>{" "}
          first if you're not sure.
        </p>
        {confirmingReset ? (
          <form onSubmit={handleReset}>
            <label>
              Enter your passphrase to confirm
              <input
                type="password"
                value={resetPassphrase}
                onChange={(e) => setResetPassphrase(e.target.value)}
                autoComplete="off"
              />
            </label>
            {resetErrors.length > 0 && (
              <ul className="form-errors">
                {resetErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            )}
            <div className="field-row">
              <button type="submit" className="danger" disabled={resetting || resetPassphrase === ""}>
                {resetting ? "Clearing…" : "Yes, clear everything"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setConfirmingReset(false);
                  setResetPassphrase("");
                  setResetErrors([]);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirmingReset(true)}>
            Clear database…
          </button>
        )}
      </section>
    </div>
  );
}
