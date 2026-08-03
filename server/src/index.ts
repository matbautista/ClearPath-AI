import express from "express";
import cors from "cors";
import "./db.js"; // bootstraps schema on first run
import { accountsRouter } from "./routes/accounts.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/accounts", accountsRouter);

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => {
  console.log(`[server] ClearPath AI API listening on http://localhost:${PORT}`);
});
