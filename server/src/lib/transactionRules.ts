// Encodes the Double-Entry Rule (spec 2.5) and the field-semantics rules
// (2.2) as data, one entry per mechanical Transaction Type (2.3), instead
// of ad-hoc per-type code. This table is the single place that decides:
// how many legs a type has, which account types are valid on each leg,
// which direction (Debit/Credit) each leg moves in, and what category
// kind (spending / income / none) applies.

export type AccountType = "Cash" | "Bank" | "EWallet" | "Investment" | "Loan" | "CreditCard";
export type Indicator = "Debit" | "Credit";
export type CategoryKind = "spending" | "income" | "none";

export type TxnType =
  | "BillsPayment"
  | "CashPayment"
  | "CashDeposit"
  | "CheckDeposit"
  | "CashWithdrawal"
  | "eCashTransfer"
  | "eCashPayment"
  | "CardPurchase"
  | "CardPayment"
  | "LoanDisbursement"
  | "LoanPayment"
  | "InvestmentBuy"
  | "InvestmentSell"
  | "DividendInterestReceived"
  | "IncomeReceived";

interface SingleLegRule {
  legs: "single";
  accountTypes: AccountType[];
  indicator: Indicator;
  categoryKind: CategoryKind;
}

interface TwoLegRule {
  legs: "two";
  sourceAccountTypes: AccountType[]; // the Debit-by-default leg in most cases — see indicator fields below
  destAccountTypes: AccountType[];
  sourceIndicator: Indicator;
  destIndicator: Indicator;
  categoryKind: CategoryKind; // mirrored on both legs when 'spending'; 'none' for Loan Disbursement
  defaultCategoryName: string | null; // e.g. 'Internal Transfer', 'Debt Payment' — null when categoryKind !== 'spending'
  categoryOverridable: boolean; // per 2.5: transfer-family lets the user pick a more specific category; Debt/Investment legs are fixed
  requiresPrincipalInterestSplit: boolean; // 2.2/2.4a — Loan/Card Payment only
}

export type TxnRule = SingleLegRule | TwoLegRule;

export const TXN_RULES: Record<TxnType, TxnRule> = {
  // --- Single-leg external outflows (Debit, Spending Category) ---
  BillsPayment: { legs: "single", accountTypes: ["Cash", "Bank", "EWallet"], indicator: "Debit", categoryKind: "spending" },
  CashPayment: { legs: "single", accountTypes: ["Cash"], indicator: "Debit", categoryKind: "spending" },
  eCashPayment: { legs: "single", accountTypes: ["Bank", "EWallet"], indicator: "Debit", categoryKind: "spending" },
  CardPurchase: { legs: "single", accountTypes: ["CreditCard"], indicator: "Debit", categoryKind: "spending" },

  // --- Single-leg external inflows (Credit, Income Category) ---
  // CheckDeposit/DividendInterestReceived deliberately exclude EWallet —
  // depositing a physical check or receiving investment dividends isn't
  // an e-wallet operation, unlike every other Bank-eligible type here.
  CheckDeposit: { legs: "single", accountTypes: ["Cash", "Bank"], indicator: "Credit", categoryKind: "income" },
  DividendInterestReceived: { legs: "single", accountTypes: ["Bank", "Investment"], indicator: "Credit", categoryKind: "income" },
  IncomeReceived: { legs: "single", accountTypes: ["Cash", "Bank", "EWallet"], indicator: "Credit", categoryKind: "income" },

  // --- Two-leg, Internal Transfer family (category user-overridable) ---
  CashWithdrawal: {
    legs: "two", sourceAccountTypes: ["Bank", "EWallet"], destAccountTypes: ["Cash"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Internal Transfer", categoryOverridable: true,
    requiresPrincipalInterestSplit: false,
  },
  CashDeposit: {
    legs: "two", sourceAccountTypes: ["Cash"], destAccountTypes: ["Bank", "EWallet"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Internal Transfer", categoryOverridable: true,
    requiresPrincipalInterestSplit: false,
  },
  eCashTransfer: {
    legs: "two", sourceAccountTypes: ["Bank", "EWallet"], destAccountTypes: ["Bank", "EWallet"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Internal Transfer", categoryOverridable: true,
    requiresPrincipalInterestSplit: false,
  },

  // --- Two-leg, fixed category, debt-related (Principal/Interest split) ---
  CardPayment: {
    legs: "two", sourceAccountTypes: ["Cash", "Bank", "EWallet"], destAccountTypes: ["CreditCard"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Debt Payment", categoryOverridable: false,
    requiresPrincipalInterestSplit: true,
  },
  LoanPayment: {
    legs: "two", sourceAccountTypes: ["Cash", "Bank", "EWallet"], destAccountTypes: ["Loan"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Debt Payment", categoryOverridable: false,
    requiresPrincipalInterestSplit: true,
  },

  // --- Two-leg, no category (borrowed principal is neither spending nor income) ---
  LoanDisbursement: {
    legs: "two", sourceAccountTypes: ["Loan"], destAccountTypes: ["Cash", "Bank", "EWallet"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "none", defaultCategoryName: null, categoryOverridable: false,
    requiresPrincipalInterestSplit: false,
  },

  // --- Two-leg, fixed category, investment-related ---
  InvestmentBuy: {
    legs: "two", sourceAccountTypes: ["Cash", "Bank", "EWallet"], destAccountTypes: ["Investment"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Savings/Investment Transfer", categoryOverridable: false,
    requiresPrincipalInterestSplit: false,
  },
  InvestmentSell: {
    legs: "two", sourceAccountTypes: ["Investment"], destAccountTypes: ["Cash", "Bank", "EWallet"],
    sourceIndicator: "Debit", destIndicator: "Credit",
    categoryKind: "spending", defaultCategoryName: "Savings/Investment Transfer", categoryOverridable: false,
    requiresPrincipalInterestSplit: false,
  },
};

export const INCOME_CATEGORIES = [
  "Salaries", "Bonuses", "Consulting Fees", "Dividends", "Interests",
  "Capital Gains", "Allowances", "Tax Credits",
] as const;
