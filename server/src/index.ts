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
import { dashboardRouter } from "./routes/dashboard.js";
import { moneyPitsRouter } from "./routes/moneyPits.js";
import { requireAuth } from "./lib/session.js";
import { runDueRecurringRules } from "./lib/recurringEngine.js";
import { backfillSnapshots } from "./lib/netWorthEngine.js";
import { runMoneyPitDetection } from "./lib/moneyPitEngine.js";

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
app.use("/api/dashboard", requireAuth, dashboardRouter);
app.use("/api/money-pits", requireAuth, moneyPitsRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`[server] ClearPath AI API listening on http://localhost:${PORT}`);

  // All three jobs share the same missed-run philosophy (2.7/3.1/3.11a):
  // run once on boot to catch up on offline time, then on a periodic
  // interval. An hour is a reasonable dev-scale cadence for jobs whose
  // actual grain is "once a day at most."
  const generatedTxns = runDueRecurringRules();
  if (generatedTxns > 0) console.log(`[recurring] generated ${generatedTxns} pending draft(s) on startup`);

  const generatedSnapshots = backfillSnapshots();
  if (generatedSnapshots > 0) console.log(`[net-worth] backfilled ${generatedSnapshots} snapshot(s) on startup`);

  const moneyPits = runMoneyPitDetection();
  if (!moneyPits.skipped) console.log(`[money-pits] ${moneyPits.categoryFlags} category trend(s), ${moneyPits.clusterFlags} cluster(s)`);

  setInterval(
    () => {
      const n = runDueRecurringRules();
      if (n > 0) console.log(`[recurring] generated ${n} pending draft(s)`);
      const s = backfillSnapshots();
      if (s > 0) console.log(`[net-worth] backfilled ${s} snapshot(s)`);
      runMoneyPitDetection();
    },
    60 * 60 * 1000
  );
});
