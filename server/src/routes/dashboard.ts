import { Router } from "express";
import { db } from "../db.js";
import { computeCurrentNetWorth } from "../lib/netWorthEngine.js";
import { computeAccountTypeTotals, computeSavingsRate, computeUpcomingDues } from "../lib/dashboardEngine.js";
import { isScheduledAiAnalysisDue } from "../lib/aiAnalysisEngine.js";

export const dashboardRouter = Router();

dashboardRouter.get("/summary", (_req, res) => {
  const totals = computeAccountTypeTotals();
  const netWorth = computeCurrentNetWorth();
  const dues = computeUpcomingDues(30);
  res.json({
    cashOnHandMinor: totals.Cash,
    totalCashInBankMinor: totals.Bank,
    totalEWalletMinor: totals.EWallet,
    totalInvestmentValueMinor: totals.Investment,
    totalRealEstateValueMinor: totals.RealEstate,
    totalLoanBalanceMinor: totals.Loan,
    totalCardBalanceMinor: totals.CreditCard,
    ...netWorth,
    upcomingDues: dues,
    aiAnalysisScheduledDue: isScheduledAiAnalysisDue(),
  });
});

dashboardRouter.get("/net-worth-trend", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 90;
  const rows = db
    .prepare(
      `SELECT snapshot_date, total_assets_minor, total_liabilities_minor, net_worth_minor
       FROM net_worth_snapshots
       ORDER BY snapshot_date DESC LIMIT ?`
    )
    .all(days) as any[];
  res.json(
    rows
      .reverse()
      .map((r) => ({
        date: r.snapshot_date,
        totalAssetsMinor: r.total_assets_minor,
        totalLiabilitiesMinor: r.total_liabilities_minor,
        netWorthMinor: r.net_worth_minor,
      }))
  );
});

dashboardRouter.get("/savings-rate", (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 30;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const result = computeSavingsRate(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  res.json({ periodDays: days, incomeMinor: result.incomeMinor, expenseMinor: result.expenseMinor, rate: result.rate });
});
