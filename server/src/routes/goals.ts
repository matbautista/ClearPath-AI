import { Router } from "express";
import { db } from "../db.js";
import { computeGoalProgress, recomputeGoalStatus, validateAllocation } from "../lib/goalEngine.js";

export const goalsRouter = Router();

const GOAL_TYPES = ["DebtPayoff", "EmergencyFund", "SavingsTarget", "InvestmentTarget", "MajorPurchase"];
const STRATEGIES = ["Snowball", "Avalanche"];

interface GoalRow {
  id: number;
  goal_type: string;
  target_amount_minor: number;
  target_date: string | null;
  strategy: string | null;
  total_monthly_payment_budget_minor: number | null;
  status: string;
}

function toApiShape(row: GoalRow) {
  const links = db
    .prepare(
      `SELECT gal.id, gal.account_id, gal.allocation_type, gal.allocation_value, a.account_name, a.account_type
       FROM goal_account_links gal JOIN accounts a ON a.id = gal.account_id
       WHERE gal.goal_id = ?`
    )
    .all(row.id) as any[];
  const progress = computeGoalProgress(row.id);
  return {
    id: row.id,
    goalType: row.goal_type,
    targetAmountMinor: row.target_amount_minor,
    targetDate: row.target_date,
    strategy: row.strategy,
    totalMonthlyPaymentBudgetMinor: row.total_monthly_payment_budget_minor,
    status: row.status,
    currentAmountMinor: progress?.currentAmountMinor ?? 0,
    links: links.map((l) => ({
      id: l.id,
      accountId: l.account_id,
      accountName: l.account_name,
      accountType: l.account_type,
      allocationType: l.allocation_type,
      allocationValue: l.allocation_value,
    })),
  };
}

goalsRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM goals ORDER BY status, id DESC").all() as unknown as GoalRow[];
  res.json(rows.map(toApiShape));
});

goalsRouter.post("/", (req, res) => {
  const { goalType, targetAmountMinor, targetDate, strategy, totalMonthlyPaymentBudgetMinor } = req.body as {
    goalType?: string;
    targetAmountMinor?: number;
    targetDate?: string;
    strategy?: string;
    totalMonthlyPaymentBudgetMinor?: number;
  };

  const errors: string[] = [];
  if (!goalType || !GOAL_TYPES.includes(goalType)) errors.push("Goal Type is required and must be valid.");
  const isDebtPayoff = goalType === "DebtPayoff";

  if (!isDebtPayoff && (targetAmountMinor == null || targetAmountMinor <= 0)) {
    errors.push("Target Amount is required for this goal type.");
  }
  if (isDebtPayoff && strategy && !STRATEGIES.includes(strategy)) {
    errors.push("Strategy must be Snowball or Avalanche.");
  }
  if (!isDebtPayoff && (strategy || totalMonthlyPaymentBudgetMinor != null)) {
    errors.push("Strategy and Total Monthly Payment Budget only apply to Debt Payoff goals (2.8).");
  }
  if (errors.length > 0) return res.status(422).json({ errors });

  const info = db
    .prepare(
      `INSERT INTO goals (goal_type, target_amount_minor, target_date, strategy, total_monthly_payment_budget_minor)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      goalType!,
      isDebtPayoff ? 0 : targetAmountMinor!,
      targetDate ?? null,
      isDebtPayoff ? (strategy ?? "Snowball") : null,
      isDebtPayoff ? (totalMonthlyPaymentBudgetMinor ?? null) : null
    );

  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(info.lastInsertRowid) as unknown as GoalRow;
  res.status(201).json(toApiShape(goal));
});

// POST /api/goals/:id/links — link an account with an allocation (3.10).
goalsRouter.post("/:id/links", (req, res) => {
  const goalId = Number(req.params.id);
  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as unknown as GoalRow | undefined;
  if (!goal) return res.status(404).json({ errors: ["Goal not found."] });

  const { accountId, allocationType, allocationValue } = req.body as {
    accountId?: number;
    allocationType?: "FixedAmount" | "Percentage";
    allocationValue?: number;
  };
  const errors: string[] = [];
  if (!accountId) errors.push("Account is required.");
  if (allocationType !== "FixedAmount" && allocationType !== "Percentage") errors.push("Allocation Type must be Fixed Amount or Percentage.");
  if (allocationValue == null || allocationValue <= 0) errors.push("Allocation Value must be positive.");
  if (allocationType === "Percentage" && allocationValue != null && allocationValue > 100) {
    errors.push("Percentage allocation can't exceed 100.");
  }
  if (errors.length > 0) return res.status(422).json({ errors });

  const account = db.prepare("SELECT status FROM accounts WHERE id = ?").get(accountId!) as { status: string } | undefined;
  if (!account) return res.status(422).json({ errors: ["Account not found."] });
  if (account.status !== "Active") return res.status(422).json({ errors: ["Closed accounts can't be linked to new Goals (2.1)."] });

  const allocationErrors = validateAllocation({ accountId: accountId!, allocationType: allocationType!, allocationValue: allocationValue! });
  if (allocationErrors.length > 0) return res.status(422).json({ errors: allocationErrors });

  try {
    db.prepare(
      `INSERT INTO goal_account_links (goal_id, account_id, allocation_type, allocation_value) VALUES (?, ?, ?, ?)`
    ).run(goalId, accountId!, allocationType!, allocationValue!);
  } catch (err) {
    return res.status(422).json({ errors: ["This account is already linked to this goal."] });
  }

  recomputeGoalStatus(goalId);
  const updated = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as unknown as GoalRow;
  res.status(201).json(toApiShape(updated));
});

// PATCH /api/goals/:id — the only manual transition is Active -> Abandoned
// (2.8: Completed is always automatic, never set by hand).
goalsRouter.patch("/:id", (req, res) => {
  const goalId = Number(req.params.id);
  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as unknown as GoalRow | undefined;
  if (!goal) return res.status(404).json({ errors: ["Goal not found."] });

  const { status } = req.body as { status?: string };
  if (status !== "Abandoned") {
    return res.status(422).json({ errors: ["Only 'Abandoned' can be set manually — Completed/Active are automatic (2.8)."] });
  }
  db.prepare("UPDATE goals SET status = 'Abandoned', updated_at = datetime('now') WHERE id = ?").run(goalId);
  const updated = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as unknown as GoalRow;
  res.json(toApiShape(updated));
});
