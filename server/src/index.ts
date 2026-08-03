import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "./db.js"; // bootstraps schema on first run
import { accountsRouter } from "./routes/accounts.js";
import { settingsRouter } from "./routes/settings.js";
import { transactionsRouter } from "./routes/transactions.js";
import { categoriesRouter } from "./routes/categories.js";
import { goalsRouter } from "./routes/goals.js";
import { utilitiesRouter } from "./routes/utilities.js";
import { incomeSourcesRouter } from "./routes/incomeSources.js";
import { taxFeesRouter } from "./routes/taxFees.js";
import { recurringRouter } from "./routes/recurring.js";
import { requireAuth } from "./lib/session.js";
import { runDueRecurringRules } from "./lib/recurringEngine.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Setup/login/status/logout are public by necessity; everything else
// requires an authenticated session (4.3 — passphrase required even for
// single-user local deployments).
app.use("/api/settings", settingsRouter);
app.use("/api/accounts", requireAuth, accountsRouter);
app.use("/api/transactions", requireAuth, transactionsRouter);
app.use("/api/categories", requireAuth, categoriesRouter);
app.use("/api/goals", requireAuth, goalsRouter);
app.use("/api/utilities", requireAuth, utilitiesRouter);
app.use("/api/income-sources", requireAuth, incomeSourcesRouter);
app.use("/api/tax-fees", requireAuth, taxFeesRouter);
app.use("/api/recurring", requireAuth, recurringRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`[server] ClearPath AI API listening on http://localhost:${PORT}`);

  // 2.7's missed-run catch-up: run once on boot (covers time the instance
  // was offline), then on a periodic interval while running. An hour is
  // a reasonable dev-scale cadence for a job whose actual grain is "once
  // a day at most" per rule.
  const generated = runDueRecurringRules();
  if (generated > 0) console.log(`[recurring] generated ${generated} pending draft(s) on startup`);
  setInterval(
    () => {
      const n = runDueRecurringRules();
      if (n > 0) console.log(`[recurring] generated ${n} pending draft(s)`);
    },
    60 * 60 * 1000
  );
});
