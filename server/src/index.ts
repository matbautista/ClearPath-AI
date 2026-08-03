import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "./db.js"; // bootstraps schema on first run
import { accountsRouter } from "./routes/accounts.js";
import { settingsRouter } from "./routes/settings.js";
import { transactionsRouter } from "./routes/transactions.js";
import { categoriesRouter } from "./routes/categories.js";
import { goalsRouter } from "./routes/goals.js";
import { requireAuth } from "./lib/session.js";

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

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`[server] ClearPath AI API listening on http://localhost:${PORT}`);
});
