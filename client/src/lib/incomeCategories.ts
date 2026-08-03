// Fixed enum (3.8) — not user-editable, unlike Spending Categories (2.4),
// so it's safe to hardcode client-side rather than fetch.
export const INCOME_CATEGORIES = [
  "Salaries",
  "Bonuses",
  "Consulting Fees",
  "Dividends",
  "Interests",
  "Capital Gains",
  "Allowances",
  "Tax Credits",
] as const;
