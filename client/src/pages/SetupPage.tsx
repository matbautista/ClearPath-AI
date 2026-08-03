import { useState } from "react";
import { api, ApiError } from "../api";

const COMMON_CURRENCIES = ["PHP", "USD", "EUR", "GBP", "JPY", "SGD", "AUD", "CAD"];

export function SetupPage({ onComplete }: { onComplete: () => void }) {
  const [baseCurrency, setBaseCurrency] = useState("PHP");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (passphrase !== confirmPassphrase) {
      setErrors(["Passphrases don't match."]);
      return;
    }
    setSubmitting(true);
    setErrors([]);
    try {
      await api.setup(baseCurrency, passphrase);
      onComplete();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.errors : ["Something went wrong."]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Set up ClearPath AI</h1>
        <p className="page-subtitle">
          This is a one-time setup for your self-hosted instance (2.0/4.3). Your base currency
          applies to every account; your passphrase protects this instance.
        </p>
        <form onSubmit={handleSubmit}>
          <label>
            Base currency
            <select value={baseCurrency} onChange={(e) => setBaseCurrency(e.target.value)}>
              {COMMON_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              minLength={8}
              required
            />
          </label>
          <label>
            Confirm passphrase
            <input
              type="password"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              minLength={8}
              required
            />
          </label>
          {errors.length > 0 && (
            <ul className="form-errors">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "Setting up…" : "Finish setup"}
          </button>
        </form>
      </div>
    </div>
  );
}
