// Mirrors the CHECK constraints on the `accounts` table (schema/schema.sql,
// spec 2.1) but with per-field, human-readable errors instead of a raw
// SQLite CHECK failure.

export type AccountType = "Cash" | "Bank" | "EWallet" | "Investment" | "Loan" | "CreditCard" | "RealEstate";

export interface AccountInput {
  accountType: AccountType;
  institutionName?: string | null;
  description?: string | null;
  accountName: string;
  beginningBalanceMinor?: number;
  interestRatePct?: number | null;
  valuationMethod?: "CostBasis" | "MarketValue" | null;
  minimumPaymentMinor?: number | null;
  creditLimitMinor?: number | null;
  loanAmountMinor?: number | null;
  loanTermMonths?: number | null;
  dueDateDay?: number | null;
  cutOffDateDay?: number | null;
  reminderLeadTimeDays?: number | null;
}

export function validateAccountInput(input: AccountInput): string[] {
  const errors: string[] = [];

  if (!input.accountName || !input.accountName.trim()) {
    errors.push("Account name is required.");
  }

  const isCreditCard = input.accountType === "CreditCard";
  const isLoan = input.accountType === "Loan";
  const isLoanOrCard = isLoan || isCreditCard;
  const isInvestment = input.accountType === "Investment";

  if (isCreditCard && (input.creditLimitMinor == null || input.creditLimitMinor <= 0)) {
    errors.push("Credit Limit is required for Credit Card accounts.");
  }
  if (!isCreditCard && input.creditLimitMinor != null) {
    errors.push("Credit Limit only applies to Credit Card accounts.");
  }
  if (!isCreditCard && input.cutOffDateDay != null) {
    errors.push("Cut-off Date only applies to Credit Card accounts.");
  }
  if (input.cutOffDateDay != null && (input.cutOffDateDay < 1 || input.cutOffDateDay > 31)) {
    errors.push("Cut-off Date must be a day of month between 1 and 31.");
  }

  if (isLoan && (input.loanAmountMinor == null || input.loanAmountMinor <= 0)) {
    errors.push("Loan Amount is required for Loan accounts.");
  }
  if (!isLoan && input.loanAmountMinor != null) {
    errors.push("Loan Amount only applies to Loan accounts.");
  }

  if (!isLoanOrCard) {
    if (input.interestRatePct != null) errors.push("Interest Rate only applies to Loan and Credit Card accounts.");
    if (input.minimumPaymentMinor != null) errors.push("Minimum Payment only applies to Loan and Credit Card accounts.");
    if (input.reminderLeadTimeDays != null) errors.push("Reminder Lead Time override only applies to Loan and Credit Card accounts.");
    if (input.dueDateDay != null) errors.push("Due Date only applies to Loan and Credit Card accounts.");
  }
  if (input.dueDateDay != null && (input.dueDateDay < 1 || input.dueDateDay > 31)) {
    errors.push("Due Date must be a day of month between 1 and 31.");
  }

  if (!isInvestment && input.valuationMethod != null) {
    errors.push("Valuation Method only applies to Investment accounts.");
  }

  if (input.beginningBalanceMinor != null && !Number.isInteger(input.beginningBalanceMinor)) {
    errors.push("Beginning Balance must be a whole number of minor units (e.g. cents) — never a fractional value.");
  }

  return errors;
}
