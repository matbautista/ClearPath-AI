// Goal completion (2.8): Status is continuously derived from linked
// accounts' live balances, never a stored flag that can drift — and
// never touches Status once it's 'Abandoned' (that's the one
// user-owned terminal state, same principle as money-pit flag
// dismissal). Called from the transaction engine after every balance
// update, and once right after a goal/link is created.
import { db } from "./../db.js";

interface GoalRow {
  id: number;
  goal_type: string;
  target_amount_minor: number;
  status: string;
}

interface LinkRow {
  account_id: number;
  allocation_type: "FixedAmount" | "Percentage";
  allocation_value: number;
  account_type: string;
  current_balance_minor: number;
  card_balance_minor: number;
}

function getGoalWithLinks(goalId: number): { goal: GoalRow; links: LinkRow[] } | null {
  const goal = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
  if (!goal) return null;
  const links = db
    .prepare(
      `SELECT gal.account_id, gal.allocation_type, gal.allocation_value,
              a.account_type, a.current_balance_minor, a.card_balance_minor
       FROM goal_account_links gal
       JOIN accounts a ON a.id = gal.account_id
       WHERE gal.goal_id = ?`
    )
    .all(goalId) as unknown as LinkRow[];
  return { goal, links };
}

function accountBalance(link: LinkRow): number {
  return link.account_type === "CreditCard" ? link.card_balance_minor : link.current_balance_minor;
}

export interface GoalProgress {
  currentAmountMinor: number;
  targetAmountMinor: number;
  isComplete: boolean;
}

// Debt Payoff: "current amount" is the remaining balance across linked
// debts, heading to a target of 0 — completes when every linked debt
// hits zero (2.8). Emergency Fund/Savings/Investment Target: "current
// amount" is the Allocation-adjusted sum of linked balances against
// Target Amount (3.10) — the same computation both the progress bar
// and the completion check use, so they can't disagree with each other.
export function computeGoalProgress(goalId: number): GoalProgress | null {
  const data = getGoalWithLinks(goalId);
  if (!data) return null;
  const { goal, links } = data;

  if (goal.goal_type === "DebtPayoff") {
    const totalRemaining = links.reduce((sum, l) => sum + accountBalance(l), 0);
    const isComplete = links.length > 0 && links.every((l) => accountBalance(l) === 0);
    return { currentAmountMinor: totalRemaining, targetAmountMinor: 0, isComplete };
  }

  const contribution = links.reduce((sum, l) => {
    const balance = accountBalance(l);
    const share =
      l.allocation_type === "FixedAmount" ? Math.min(l.allocation_value, balance) : Math.floor((balance * l.allocation_value) / 100);
    return sum + share;
  }, 0);
  const isComplete = contribution >= goal.target_amount_minor;
  return { currentAmountMinor: contribution, targetAmountMinor: goal.target_amount_minor, isComplete };
}

export function recomputeGoalStatus(goalId: number) {
  const data = getGoalWithLinks(goalId);
  if (!data || data.goal.status === "Abandoned") return;
  const progress = computeGoalProgress(goalId);
  if (!progress) return;
  const newStatus = progress.isComplete ? "Completed" : "Active";
  if (newStatus !== data.goal.status) {
    db.prepare("UPDATE goals SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, goalId);
  }
}

export function recomputeGoalsForAccount(accountId: number) {
  const rows = db
    .prepare(
      `SELECT DISTINCT g.id FROM goals g
       JOIN goal_account_links gal ON gal.goal_id = g.id
       WHERE gal.account_id = ? AND g.status != 'Abandoned'`
    )
    .all(accountId) as { id: number }[];
  for (const row of rows) recomputeGoalStatus(row.id);
}

// Allocation over-commit validation (3.10): edit-time only, per the v9
// decision — checks against the account's *current* balance, and never
// re-runs retroactively when that balance later drops (see schema.sql).
export function validateAllocation(opts: {
  accountId: number;
  allocationType: "FixedAmount" | "Percentage";
  allocationValue: number;
  excludeGoalId?: number; // when editing an existing link
}): string[] {
  const account = db
    .prepare("SELECT account_type, current_balance_minor, card_balance_minor FROM accounts WHERE id = ?")
    .get(opts.accountId) as { account_type: string; current_balance_minor: number; card_balance_minor: number } | undefined;
  if (!account) return ["Account not found."];
  const balance = account.account_type === "CreditCard" ? account.card_balance_minor : account.current_balance_minor;

  const existingLinks = db
    .prepare(
      `SELECT gal.goal_id, gal.allocation_type, gal.allocation_value, g.goal_type
       FROM goal_account_links gal
       JOIN goals g ON g.id = gal.goal_id
       WHERE gal.account_id = ? AND g.status != 'Abandoned'`
    )
    .all(opts.accountId) as { goal_id: number; allocation_type: string; allocation_value: number; goal_type: string }[];

  const shareOf = (allocationType: string, allocationValue: number) =>
    allocationType === "FixedAmount" ? allocationValue : Math.floor((balance * allocationValue) / 100);

  const existingTotal = existingLinks
    .filter((l) => l.goal_id !== opts.excludeGoalId)
    .reduce((sum, l) => sum + shareOf(l.allocation_type, l.allocation_value), 0);
  const newShare = shareOf(opts.allocationType, opts.allocationValue);

  if (existingTotal + newShare > balance) {
    return [
      `This allocation would push the account's total linked-goal allocation past 100% of its current balance (3.10). ` +
        `Already allocated: ${existingTotal}, this request: ${newShare}, balance: ${balance} (all in minor units).`,
    ];
  }
  return [];
}
