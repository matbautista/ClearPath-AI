export type AccountType = "Cash" | "Bank" | "EWallet" | "Investment" | "Loan" | "CreditCard";
export type AccountStatus = "Active" | "Closed";

export interface Account {
  id: number;
  accountType: AccountType;
  institutionName: string | null;
  description: string | null;
  accountName: string;
  beginningBalanceMinor: number;
  currentBalanceMinor: number | null; // null for CreditCard
  cardBalanceMinor: number | null; // null for non-CreditCard
  availableBalanceMinor: number | null; // CreditCard only, derived
  interestRatePct: number | null;
  valuationMethod: "CostBasis" | "MarketValue" | null;
  minimumPaymentMinor: number | null;
  creditLimitMinor: number | null;
  loanAmountMinor: number | null;
  loanTermMonths: number | null;
  dueDateDay: number | null;
  cutOffDateDay: number | null;
  reminderLeadTimeDays: number | null;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewAccountInput {
  accountType: AccountType;
  accountName: string;
  institutionName?: string;
  description?: string;
  beginningBalanceMinor?: number;
  interestRatePct?: number;
  minimumPaymentMinor?: number;
  creditLimitMinor?: number;
  loanAmountMinor?: number;
  loanTermMonths?: number;
  dueDateDay?: number;
  cutOffDateDay?: number;
}

// Account Type and Beginning Balance aren't included — see the PATCH
// handler in server/src/routes/accounts.ts for why they're not editable.
export interface EditAccountInput {
  accountName: string;
  institutionName?: string;
  interestRatePct?: number;
  creditLimitMinor?: number;
  loanAmountMinor?: number;
  status: AccountStatus;
}
