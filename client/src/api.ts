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

async function handle<T>(res: Response): Promise<T> {
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new ApiError(res.status, body.errors ?? ["Unknown error."]);
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

export const api = {
  // auth / settings
  settingsStatus: (): Promise<SettingsStatus> => get("/api/settings/status"),
  setup: (baseCurrency: string, passphrase: string): Promise<Settings> =>
    post("/api/settings/setup", { baseCurrency, passphrase }),
  login: (passphrase: string): Promise<{ ok: true }> => post("/api/settings/login", { passphrase }),
  logout: (): Promise<{ ok: true }> => post("/api/settings/logout"),
  me: (): Promise<Settings> => get("/api/settings/me"),

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
};
