import type { Account, NewAccountInput } from "./types";

export class ApiError extends Error {
  status: number;
  errors: string[];
  constructor(status: number, errors: string[]) {
    super(errors.join(" "));
    this.status = status;
    this.errors = errors;
  }
}

// Any API call can 401 if the session expires or the server restarts
// (session state is in-memory, see server/src/lib/session.ts) — without
// this, a page's own error handling would silently show an empty list
// instead of explaining why. The app registers a handler on mount that
// bounces back to the Login screen.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function handle<T>(res: Response): Promise<T> {
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, body.errors ?? ["Unknown error."]);
  }
  return body as T;
}

function get<T>(path: string): Promise<T> {
  return fetch(path, { credentials: "include" }).then(handle<T>);
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(handle<T>);
}

function patch<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(handle<T>);
}

export interface SettingsStatus {
  configured: boolean;
}
export interface Settings {
  baseCurrency: string;
  aiAnalysisEnabled: boolean;
  aiProvider: string | null;
  aiScheduledAutoRun: boolean;
  aiLastCallAt: string | null;
  aiCallCount: number;
  notificationEmail: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUsername: string | null;
  defaultReminderLeadTimeDays: number;
}

export interface SpendingCategory {
  id: number;
  name: string;
  isSystem: boolean;
}

export interface TransactionRule {
  legs: "single" | "two";
  accountTypes?: string[];
  sourceAccountTypes?: string[];
  destAccountTypes?: string[];
  indicator?: "Debit" | "Credit";
  sourceIndicator?: "Debit" | "Credit";
  destIndicator?: "Debit" | "Credit";
  categoryKind: "spending" | "income" | "none";
  defaultCategoryName?: string | null;
  categoryOverridable?: boolean;
  requiresPrincipalInterestSplit?: boolean;
}

export interface TransactionRulesResponse {
  rules: Record<string, TransactionRule>;
  incomeCategories: string[];
}

export interface Transaction {
  id: number;
  description: string | null;
  txnDate: string;
  amountMinor: number;
  additionalFeesMinor: number;
  indicator: "Debit" | "Credit";
  sourceAccountId: number;
  destinationAccountId: number | null;
  destinationAccountName: string | null;
  txnType: string;
  spendingCategoryName: string | null;
  incomeCategory: string | null;
  principalPortionMinor: number | null;
  interestPortionMinor: number | null;
  linkedTransactionId: number | null;
  status: string;
}

export interface NewTransactionInput {
  txnType: string;
  txnDate: string;
  description?: string;
  amountMinor: number;
  additionalFeesMinor?: number;
  sourceAccountId: number;
  destinationAccountId?: number;
  spendingCategoryId?: number;
  incomeCategory?: string;
  principalPortionMinor?: number;
  interestPortionMinor?: number;
}

export interface GoalLink {
  id: number;
  accountId: number;
  accountName: string;
  accountType: string;
  allocationType: "FixedAmount" | "Percentage";
  allocationValue: number;
}

export interface Goal {
  id: number;
  goalType: "DebtPayoff" | "EmergencyFund" | "SavingsTarget" | "InvestmentTarget";
  targetAmountMinor: number;
  targetDate: string | null;
  strategy: "Snowball" | "Avalanche" | null;
  totalMonthlyPaymentBudgetMinor: number | null;
  status: "Active" | "Completed" | "Abandoned";
  currentAmountMinor: number;
  links: GoalLink[];
}

export interface NewGoalInput {
  goalType: string;
  targetAmountMinor?: number;
  targetDate?: string;
  strategy?: string;
  totalMonthlyPaymentBudgetMinor?: number;
}

export interface NewGoalLinkInput {
  accountId: number;
  allocationType: "FixedAmount" | "Percentage";
  allocationValue: number;
}

export type Schedule = "Annually" | "Quarterly" | "Monthly" | "Bi-Monthly" | "Variable";

export interface Utility {
  id: number;
  providerName: string;
  description: string | null;
  serviceAccountNumber: string | null;
  serviceAccountName: string | null;
  defaultAccountId: number;
  defaultAccountName: string;
  cutOffDateDay: number | null;
  dueDateDay: number | null;
  policyType: string | null;
  recurringRuleId: number;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate: string | null;
  reminderLeadTimeDays: number | null;
}

export interface NewUtilityInput {
  providerName: string;
  description?: string;
  serviceAccountNumber?: string;
  serviceAccountName?: string;
  defaultAccountId: number;
  cutOffDateDay?: number;
  dueDateDay?: number;
  policyType?: string;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate?: string;
  reminderLeadTimeDays?: number;
}

export interface IncomeSource {
  id: number;
  sourceName: string;
  description: string | null;
  incomeCategory: string;
  creditToAccountId: number;
  creditToAccountName: string;
  recurringRuleId: number;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate: string | null;
  reminderLeadTimeDays: number | null;
}

export interface NewIncomeSourceInput {
  sourceName: string;
  description?: string;
  incomeCategory: string;
  creditToAccountId: number;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate?: string;
  reminderLeadTimeDays?: number;
}

export interface TaxFee {
  id: number;
  regulatoryName: string;
  description: string | null;
  feeCategory: string | null;
  debitFromAccountId: number;
  debitFromAccountName: string;
  recurringRuleId: number;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate: string | null;
  reminderLeadTimeDays: number | null;
}

export interface NewTaxFeeInput {
  regulatoryName: string;
  description?: string;
  feeCategory?: string;
  debitFromAccountId: number;
  schedule: Schedule;
  templateAmountMinor: number;
  nextRunDate?: string;
  reminderLeadTimeDays?: number;
}

export interface UpcomingDue {
  label: string;
  dueDate: string;
  amountMinor: number;
  source: "Loan" | "CreditCard" | "Utility" | "TaxFee";
}

export interface DashboardSummary {
  cashOnHandMinor: number;
  totalCashInBankMinor: number;
  totalEWalletMinor: number;
  totalInvestmentValueMinor: number;
  totalLoanBalanceMinor: number;
  totalCardBalanceMinor: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  netWorthMinor: number;
  upcomingDues: UpcomingDue[];
}

export interface NetWorthTrendPoint {
  date: string;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  netWorthMinor: number;
}

export interface SavingsRateResult {
  periodDays: number;
  incomeMinor: number;
  expenseMinor: number;
  rate: number | null;
}

export interface MoneyPitFlag {
  id: number;
  flagType: "CategoryTrend" | "RecurringChargeCluster";
  spendingCategoryName: string | null;
  clusterDescription: string | null;
  metric: { growthPct?: number; currentMonthMinor?: number; trailingAvgMinor?: number; occurrenceCount?: number; avgAmountMinor?: number; monthlyEquivalentMinor?: number } | null;
  utilizationNote: string | null;
  status: "Active" | "Dismissed";
  detectedAt: string;
  dismissedAt: string | null;
}

export interface AiAnalysisRun {
  id: number;
  ranAt: string;
  status: "Success" | "Failed";
  outputText: string | null;
  errorMessage: string | null;
}

export interface UpdateAiSettingsInput {
  aiAnalysisEnabled?: boolean;
  aiProvider?: string;
  aiApiKey?: string;
  aiScheduledAutoRun?: boolean;
}

export interface PendingTransaction {
  id: number;
  txnDate: string;
  amountMinor: number;
  indicator: "Debit" | "Credit";
  sourceAccountId: number;
  sourceAccountName: string;
  txnType: string;
  spendingCategoryName: string | null;
  incomeCategory: string | null;
}

export const api = {
  // auth / settings
  settingsStatus: (): Promise<SettingsStatus> => get("/api/settings/status"),
  setup: (baseCurrency: string, passphrase: string): Promise<Settings> =>
    post("/api/settings/setup", { baseCurrency, passphrase }),
  login: (passphrase: string): Promise<{ ok: true }> => post("/api/settings/login", { passphrase }),
  logout: (): Promise<{ ok: true }> => post("/api/settings/logout"),
  me: (): Promise<Settings> => get("/api/settings/me"),
  updateAiSettings: (input: UpdateAiSettingsInput): Promise<{ ok: true }> => patch("/api/settings/ai", input),

  // AI Analysis (3.11)
  runAiAnalysis: (): Promise<{ outputText: string }> => post("/api/ai-analysis/run"),
  listAiRuns: (): Promise<AiAnalysisRun[]> => get("/api/ai-analysis/runs"),

  // accounts
  listAccounts: (): Promise<Account[]> => get("/api/accounts"),
  createAccount: (input: NewAccountInput): Promise<Account> => post("/api/accounts", input),

  // categories
  listCategories: (): Promise<SpendingCategory[]> => get("/api/categories"),

  // transactions
  transactionRules: (): Promise<TransactionRulesResponse> => get("/api/transactions/rules"),
  listTransactions: (accountId?: number): Promise<Transaction[]> =>
    get(`/api/transactions${accountId ? `?accountId=${accountId}` : ""}`),
  createTransaction: (input: NewTransactionInput): Promise<{ id: number; linkedTransactionId: number | null }> =>
    post("/api/transactions", input),
  voidTransaction: (id: number): Promise<{ voidedIds: number[] }> => post(`/api/transactions/${id}/void`),

  // goals
  listGoals: (): Promise<Goal[]> => get("/api/goals"),
  createGoal: (input: NewGoalInput): Promise<Goal> => post("/api/goals", input),
  addGoalLink: (goalId: number, input: NewGoalLinkInput): Promise<Goal> => post(`/api/goals/${goalId}/links`, input),
  abandonGoal: (goalId: number): Promise<Goal> => patch(`/api/goals/${goalId}`, { status: "Abandoned" }),

  // recurring: utilities / income sources / tax fees / pending confirmations
  listUtilities: (): Promise<Utility[]> => get("/api/utilities"),
  createUtility: (input: NewUtilityInput): Promise<{ id: number }> => post("/api/utilities", input),
  listIncomeSources: (): Promise<IncomeSource[]> => get("/api/income-sources"),
  createIncomeSource: (input: NewIncomeSourceInput): Promise<{ id: number }> => post("/api/income-sources", input),
  listTaxFees: (): Promise<TaxFee[]> => get("/api/tax-fees"),
  createTaxFee: (input: NewTaxFeeInput): Promise<{ id: number }> => post("/api/tax-fees", input),
  listPending: (): Promise<PendingTransaction[]> => get("/api/recurring/pending"),
  confirmPending: (id: number, amountMinor?: number): Promise<{ ok: true }> =>
    post(`/api/recurring/pending/${id}/confirm`, amountMinor != null ? { amountMinor } : {}),
  skipPending: (id: number): Promise<{ ok: true }> => post(`/api/recurring/pending/${id}/skip`),
  runDueRecurring: (): Promise<{ generated: number }> => post("/api/recurring/run-due"),

  // dashboard
  dashboardSummary: (): Promise<DashboardSummary> => get("/api/dashboard/summary"),
  netWorthTrend: (days = 90): Promise<NetWorthTrendPoint[]> => get(`/api/dashboard/net-worth-trend?days=${days}`),
  savingsRate: (days = 30): Promise<SavingsRateResult> => get(`/api/dashboard/savings-rate?days=${days}`),

  // money pits
  listMoneyPits: (): Promise<MoneyPitFlag[]> => get("/api/money-pits"),
  dismissMoneyPit: (id: number): Promise<{ ok: true }> => post(`/api/money-pits/${id}/dismiss`),
  setMoneyPitNote: (id: number, note: string): Promise<{ ok: true }> => post(`/api/money-pits/${id}/utilization-note`, { note }),
};
