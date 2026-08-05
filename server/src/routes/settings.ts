import { Router } from "express";
import { db } from "../db.js";
import { hashPassphrase, verifyPassphrase } from "../lib/passphrase.js";
import { createSession, destroySession, SESSION_COOKIE, requireAuth } from "../lib/session.js";
import { encrypt } from "../lib/encryption.js";

export const settingsRouter = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  // NOTE: `secure: true` should be turned on once this is served over
  // HTTPS (4.3 requires TLS for the app itself) — left off for local dev.
};

interface SettingsRow {
  id: number;
  base_currency: string;
  auth_passphrase_hash: string;
  ai_analysis_enabled: number;
  ai_provider: string | null;
  ai_scheduled_auto_run: number;
  ai_last_call_at: string | null;
  ai_call_count: number;
  notification_email: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_username: string | null;
  default_reminder_lead_time_days: number;
}

function getSettingsRow(): SettingsRow | undefined {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow | undefined;
}

// Public — the client uses this to decide whether to show Setup or Login.
settingsRouter.get("/status", (_req, res) => {
  res.json({ configured: !!getSettingsRow() });
});

// Public, first-run only (2.0/4.3): creates the single Settings row.
settingsRouter.post("/setup", (req, res) => {
  if (getSettingsRow()) {
    return res.status(409).json({ errors: ["Already set up — use /login instead."] });
  }
  const { baseCurrency, passphrase } = req.body as { baseCurrency?: string; passphrase?: string };
  const errors: string[] = [];
  if (!baseCurrency || !/^[A-Z]{3}$/.test(baseCurrency)) {
    errors.push("Base Currency must be a 3-letter ISO 4217 code (e.g. PHP, USD).");
  }
  if (!passphrase || passphrase.length < 8) {
    errors.push("Passphrase must be at least 8 characters.");
  }
  if (errors.length > 0) return res.status(422).json({ errors });

  db.prepare(
    `INSERT INTO settings (id, base_currency, auth_passphrase_hash, default_reminder_lead_time_days)
     VALUES (1, ?, ?, 3)`
  ).run(baseCurrency!, hashPassphrase(passphrase!));

  const token = createSession();
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTS);
  res.status(201).json({ baseCurrency });
});

settingsRouter.post("/login", (req, res) => {
  const row = getSettingsRow();
  if (!row) return res.status(409).json({ errors: ["Not set up yet — use /setup first."] });
  const { passphrase } = req.body as { passphrase?: string };
  if (!passphrase || !verifyPassphrase(passphrase, row.auth_passphrase_hash)) {
    return res.status(401).json({ errors: ["Incorrect passphrase."] });
  }
  const token = createSession();
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTS);
  res.json({ ok: true });
});

settingsRouter.post("/logout", (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

// Authenticated — non-secret fields only. Never returns
// auth_passphrase_hash, ai_api_key_encrypted, or smtp_password_encrypted.
settingsRouter.get("/me", requireAuth, (_req, res) => {
  const row = getSettingsRow();
  if (!row) return res.status(404).json({ errors: ["Not set up yet."] });
  res.json({
    baseCurrency: row.base_currency,
    aiAnalysisEnabled: !!row.ai_analysis_enabled,
    aiProvider: row.ai_provider,
    aiScheduledAutoRun: !!row.ai_scheduled_auto_run,
    aiLastCallAt: row.ai_last_call_at,
    aiCallCount: row.ai_call_count,
    notificationEmail: row.notification_email,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpUsername: row.smtp_username,
    defaultReminderLeadTimeDays: row.default_reminder_lead_time_days,
  });
});

// AI Analysis configuration (3.11): explicit opt-in toggle, provider
// choice, BYOK API key (encrypted at rest — never echoed back), and the
// scheduled-auto-run opt-in. aiApiKey is write-only: omit it to leave the
// stored key untouched, send "" to clear it.
settingsRouter.patch("/ai", requireAuth, (req, res) => {
  const row = getSettingsRow();
  if (!row) return res.status(404).json({ errors: ["Not set up yet."] });

  const { aiAnalysisEnabled, aiProvider, aiApiKey, aiScheduledAutoRun } = req.body as {
    aiAnalysisEnabled?: boolean;
    aiProvider?: string;
    aiApiKey?: string;
    aiScheduledAutoRun?: boolean;
  };

  const errors: string[] = [];
  if (aiProvider !== undefined && aiProvider !== "Anthropic") {
    errors.push("Only the Anthropic provider is currently supported.");
  }
  if (aiAnalysisEnabled === true) {
    const willHaveProvider = aiProvider ?? row.ai_provider;
    const willHaveKey = aiApiKey !== undefined ? aiApiKey.length > 0 : hasStoredApiKey();
    if (!willHaveProvider) errors.push("Choose an AI provider before enabling AI Analysis.");
    if (!willHaveKey) errors.push("Add an API key before enabling AI Analysis.");
  }
  if (errors.length > 0) return res.status(422).json({ errors });

  const sets: string[] = [];
  const values: unknown[] = [];
  if (aiAnalysisEnabled !== undefined) {
    sets.push("ai_analysis_enabled = ?");
    values.push(aiAnalysisEnabled ? 1 : 0);
  }
  if (aiProvider !== undefined) {
    sets.push("ai_provider = ?");
    values.push(aiProvider);
  }
  if (aiApiKey !== undefined) {
    sets.push("ai_api_key_encrypted = ?");
    values.push(aiApiKey === "" ? null : encrypt(aiApiKey));
  }
  if (aiScheduledAutoRun !== undefined) {
    sets.push("ai_scheduled_auto_run = ?");
    values.push(aiScheduledAutoRun ? 1 : 0);
  }
  if (sets.length === 0) return res.status(422).json({ errors: ["No fields provided."] });

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`).run(...(values as any[]));
  res.json({ ok: true });
});

// Every table except settings/spending_categories, which get special
// handling below.
const RESET_TABLES = [
  "money_pit_flag_transactions",
  "money_pit_flags",
  "ai_analysis_runs",
  "net_worth_snapshots",
  "goal_account_links",
  "goals",
  "recurring_rules",
  "tax_fees",
  "income_sources",
  "utilities",
  "transactions",
  "accounts",
];

// POST /api/settings/reset — wipes all app data and returns the instance to
// its pre-Setup state (2.0/4.3), for starting over or for wiping this
// machine's copy before/after moving to another one (DEPLOY.md "Moving to
// another machine"). Requires re-entering the current passphrase as
// confirmation — the one genuinely irreversible action in the app.
settingsRouter.post("/reset", requireAuth, (req, res) => {
  const row = getSettingsRow();
  if (!row) return res.status(404).json({ errors: ["Not set up yet."] });

  const { passphrase } = req.body as { passphrase?: string };
  if (!passphrase || !verifyPassphrase(passphrase, row.auth_passphrase_hash)) {
    // 422, not 401: the request is already authenticated (requireAuth
    // passed) — this is confirmation-input validation, not a session
    // failure. A 401 here would trip the client's global "any 401 means
    // session expired" handler (api.ts) and silently bounce to Login
    // before this error ever reached the Settings page's own handling.
    return res.status(422).json({ errors: ["Incorrect passphrase."] });
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    for (const table of RESET_TABLES) db.exec(`DELETE FROM ${table}`);
    // Keep the seeded system categories (2.4) intact — money-pit/savings-rate
    // logic depends on the default set existing by name, and re-inserting it
    // here would duplicate schema.sql's seed list. Only user-added categories
    // (is_system = 0) are cleared.
    db.exec("DELETE FROM spending_categories WHERE is_system = 0");
    db.exec("DELETE FROM settings");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

function hasStoredApiKey(): boolean {
  const row = db.prepare("SELECT ai_api_key_encrypted FROM settings WHERE id = 1").get() as
    | { ai_api_key_encrypted: Uint8Array | null }
    | undefined;
  return !!row?.ai_api_key_encrypted;
}
