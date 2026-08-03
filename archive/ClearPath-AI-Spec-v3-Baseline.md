# ClearPath AI — Personal Finance App
## Product Specification v3 — BASELINE

**Status: Baselined.** This version is frozen as the reference for implementation (database schema, ER diagram, build work). Further changes should be made as a new version (v4) rather than edited in place, so this baseline stays a stable point to build against and compare future changes to.

A web app with a self-hosted, lightweight database that helps users pay off debt as fast as possible, build an emergency fund, and eventually invest to grow their money.

---

## 1. Core Goals

a. Track cash on hand.
b. Track cash in bank.
c. Track investments.
d. Track existing loans.
e. Track credit card transactions and payments.
f. Track utility payments.
g. Track income sources.
h. Track taxes and regulatory fee payments.
i. Set up and track financial goals.
j. AI-powered analysis of current financial standing with a plan to achieve stated goals, including detection of spending patterns ("money pits") worth the user's attention.

---

## 2. Data Model

### 2.0 User & Settings Model

Several v1 features (base currency, AI opt-in, notification delivery, authentication) assume a settings surface that wasn't previously modeled. Since ClearPath AI is single-user (2.1), this is one `Settings` record per instance rather than a multi-tenant `User` table.

**Settings**
| Field | Notes |
|---|---|
| Base Currency | Set once during initial setup (4.2); ISO 4217 code (e.g., PHP, USD) |
| Auth Credentials | Passphrase hash for instance login (4.3) |
| AI Analysis Enabled | Boolean, off by default until explicit opt-in (3.11) |
| AI API Key | User-supplied key for the external provider (3.11) — encrypted at rest, never logged |
| AI Provider | Which external API the key belongs to |
| Notification Email | Address for reminder delivery (4.5) |
| SMTP Configuration | Host, port, credentials for outbound email (4.5) — self-hosted apps have no built-in mail server, so the user supplies their own |
| Default Reminder Lead Time | Global default, e.g., 3 days before Due Date. Individual Loans/Credit Cards/Utilities/Income Sources/Tax records may optionally override this with their own lead time (4.5); when absent, this default applies. |

### 2.1 Unified Account Model

Rather than treating Cash on Hand, Cash in Bank, Investments, Loans, and Credit Cards as five separate modules, they share one underlying `Account` entity. This avoids repeating the same setup/balance/transaction-list logic five times, and makes it trivial to add new account types later (e.g., e-wallets, crypto).

**Account**
| Field | Notes |
|---|---|
| Account ID | |
| Account Type | Cash, Bank, Investment, Loan, Credit Card |
| Institution / Issuer Name | Bank, broker, lender, card issuer (blank for Cash) |
| Description | User label |
| Account Number | Optional, encrypted at rest |
| Account Name | Name on account |
| Beginning Balance | |
| Current Balance | Derived from transaction history (see Valuation Method for Investment accounts) |
| Interest Rate | Loan and Credit Card only — annual %. Used to rank debts for the Avalanche goal strategy (3.10) and to suggest (not auto-post) an interest split on new payments — see 2.4a for why the actual split remains manual entry in v1. |
| Valuation Method | Investment only — "Cost Basis" (balance only changes on buy/sell/dividend transactions) or "Market Value" (balance also updates from periodic price marks). See 2.4a. |
| Minimum Payment | Loan and Credit Card only — the account's stated minimum due each cycle. Feeds the Multi-debt allocation rule (3.10) and the Dashboard's upcoming-dues breakdown (3.1). |
| Credit Limit | Credit Card only |
| Loan Amount / Term | Loan only |
| Cut-off Date / Due Date | Credit Card, Loan, Utility |
| Status | Active or Closed/Archived — closed accounts keep their transaction history but are excluded from Dashboard totals and cannot be linked to new transactions or new Goals. A Goal referencing a closed account is flagged for the user to re-link or retire. |

For v1, ClearPath AI is scoped as **single-user**. There is no household/shared-finances concept and no account-owner field; multi-user support is a future consideration, not part of this spec.

### 2.2 Transaction Model

The original spec's "Category" field mixed two different concepts — how money moved, and what it was spent on. These are split:

**Transaction**
| Field | Notes |
|---|---|
| Transaction ID | |
| Description | |
| Date | |
| Amount | |
| Additional Fees | Bank transfer fees, etc. |
| Total Amount | Amount + Additional Fees |
| Indicator | Debit or Credit |
| Source Account | Required |
| Destination Account | Required for transfers/payments, null otherwise |
| Transaction Type | Mechanical type — see 2.3 |
| Spending Category | Budget-relevant category — see 2.4 |
| Principal Portion / Interest Portion | Loan Payment and Card Payment only — required split of Amount, so Loan/Card Balance reduces by Principal Portion only and Interest Portion feeds expense reporting and the AI analysis. See 2.2a. |
| Linked Transaction ID | Self-reference to the paired leg for two-leg transactions (transfers, buy/sell, payments). See 2.5. |
| Status | Posted, Voided, or Pending Confirmation (auto-drafted recurring items awaiting user confirmation — see 2.7) |

All monetary fields use fixed-point decimal storage (2 decimal places, minor-unit safe) — never floating point — since balances are derived by summing transaction history and rounding drift would compound over time.

### 2.3 Transaction Types (mechanical)

Bills, Bills Payment, Cash Payment, Cash Deposit, Check Deposit, Cash Withdrawal, eCash Transfer, eCash Payment, Card Purchase, Card Payment, Loan Disbursement, Loan Payment, Investment Buy, Investment Sell, Dividend/Interest Received, Income Received.

### 2.4 Spending Categories (budget-relevant, user-editable)

Default set: Groceries, Rent/Housing, Transportation, Utilities, Dining, Entertainment, Healthcare, Insurance, Debt Payment, Savings/Investment Transfer, Taxes/Fees, Other.

This is what the AI analysis and future budgeting features actually reason over — the mechanical type alone (e.g., "eCash Transfer") tells you nothing about what the money was for.

### 2.4a Investment Valuation & Loan/Card Interest Split

- **Investment Current Balance (decided)**: v1 is **Cost Basis only** — balance changes solely on Buy/Sell/Dividend transactions and does not reflect market fluctuations. Net Worth for Investment accounts will understate/overstate true value between transactions; this is an accepted v1 tradeoff. The `Valuation Method` field (2.1) is retained in the schema but fixed to "Cost Basis" — Market Value mode (price marks, price-feed integration) is out of scope for v1 and deferred indefinitely, not actively planned.
- **Loan/Card Payment split (decided)**: v1 uses **manual entry** — the user specifies the Principal Portion and Interest Portion on every Loan Payment or Card Payment transaction; there is no amortization-schedule auto-calculation in v1. To reduce friction, the form may **pre-fill a suggested split** computed from the account's Interest Rate (2.1) and current balance, but the user can freely override it before posting — the field is advisory, not authoritative. Only the Principal Portion reduces Loan Balance / Card Balance. Interest Portion posts to the "Debt Payment" spending category as an expense so the AI analysis can see true cost of debt. Auto-calculated amortization is a reasonable future enhancement once the manual flow is validated with real usage.

### 2.4b Credit Card Billing Cycle

A Card Purchase is assigned to the statement period whose Cut-off Date falls after the transaction date. Available Balance decreases immediately on purchase; Card Balance (the amount owed) is what's due by the following Due Date. A Card Payment reduces Card Balance and increases Available Balance regardless of which statement period it's applied to. On a partial payment, the unpaid remainder carries forward to the next cycle; the card issuer will typically charge interest on it, but consistent with the manual-entry decision in 2.4a, ClearPath AI does **not** auto-post that interest charge. The user records it as a normal Card Payment (or standalone charge) transaction with its Interest Portion filled in once it appears on their statement — the account's Interest Rate (2.1) only pre-fills a suggested split, it never posts a charge on its own.

### 2.5 Double-Entry Rule (applies system-wide)

Every transaction has a **source account** and, where money moves between two accounts the user owns or owes, a **destination account**. The system always updates both sides. This single rule replaces the need to separately document balance-update behavior for every module:

- Bank-to-bank transfer → debit source bank, credit destination bank.
- Cash withdrawal from bank → debit bank, credit cash on hand.
- Credit card bill payment → debit source (cash/bank), credit card balance (reduce Card Balance, increase Available Balance).
- Loan payment → debit source (cash/bank), credit loan balance (reduce Loan Balance).
- Investment purchase → debit source (cash/bank), credit investment account.
- Investment sale → debit investment account, credit destination (cash/bank).
- Dividend received → credit investment or bank account, source is external (income).
- Utility/tax payment → debit source (cash/bank), source is external (expense, no destination account).

This also gives a natural audit trail and makes net worth calculation a straightforward sum across accounts.

**Additional Fees handling** (new): a transfer/transaction fee (2.2) is debited from the **source account only** — the destination account (if any) always receives exactly the Amount, never Amount minus fee. The fee itself is tracked under the "Taxes/Fees" spending category (2.4) on the source leg, so it shows up in spending reports and the AI analysis as its own line item rather than being invisibly absorbed into the transfer.

### 2.6 Editing & Voiding

Transactions are **immutable** once posted. Corrections are made by voiding the original (status → Voided, balances reversed) and creating a new correct transaction. This preserves an accurate audit trail rather than allowing silent edits to historical balances.

**Paired-leg voiding**: for any transaction with a Linked Transaction ID (transfers, buy/sell, payments — see 2.5), voiding either leg automatically voids its paired leg in the same operation. The two legs can never exist in different states (one posted, one voided) — this is enforced at the data layer, not left to the user to do twice.

### 2.7 Recurring Rule Model

Sections 3.7–3.9 describe auto-drafted pending transactions for Utilities, Income, and Taxes/Fees, but nothing in the data model previously generated them. A `Recurring Rule` entity closes that gap:

**Recurring Rule**
| Field | Notes |
|---|---|
| Rule ID | |
| Applies To | Utility, Income Source, or Tax/Fee record it's generated from |
| Schedule | Annually, Quarterly, Monthly, Bi-Monthly, Variable (Variable schedules do not auto-generate — user creates transactions manually) |
| Template Amount | Default amount for the drafted transaction, editable per-instance before posting |
| Next Run Date | When the next draft should be generated |
| Last Generated Transaction ID | Reference to the most recent draft, for tracking confirm/skip status |

A scheduled job checks `Next Run Date` daily; when due, it creates a Transaction with Status = **Pending Confirmation** (an addition to the Posted/Voided states in 2.2/2.6) and advances Next Run Date to the following cycle. Pending transactions don't affect account balances until the user confirms them (3.7).

**Missed-run handling**: consistent with the Net Worth snapshot job's approach (3.1), if the self-hosted instance is offline past one or more `Next Run Date`s, the job catches up on next login — generating one Pending Confirmation draft per missed cycle (not silently skipping or silently batching them into one), so the user sees and confirms each cycle they'd have been reminded about.

---

## 3. Modules

### 3.1 Dashboard
- Cash on Hand
- Total Cash in Bank
- Total Investment Value
- Total Loan Balance
- Total Card Balance
- **Net Worth** (Assets − Liabilities, new)
- **Net Worth trend chart** (new — most motivating view for a debt-payoff/savings app). Data source: a scheduled job takes a **daily snapshot** of total Assets, Liabilities, and Net Worth and stores it as a lightweight time-series record (separate from transaction history). The trend chart reads from these snapshots rather than reconstructing historical balances from transactions on every page load. **Missed-run handling**: since this is self-hosted, the instance may be offline at the scheduled time — on next login, the app checks for gaps since the last snapshot and back-fills them from transaction history (reconstructing point-in-time balances for the missed dates) rather than leaving silent gaps in the trend chart.
- Breakdown of upcoming dues (loans, cards, utilities, taxes). **Data source** (new): this list merges two different origins into one sorted-by-date view — Loan/Credit Card items read directly from the Account's `Due Date` and `Minimum Payment` fields (2.1), while Utility/Income/Tax items read from each linked Recurring Rule's `Next Run Date` and `Template Amount` (2.7). Both feed the same widget so the user sees one unified list rather than two separate ones.
- **Money-pit flags** (new): dismissible list of spending patterns surfaced by 3.11a — works independently of whether AI Analysis (3.11) is enabled.

### 3.2 Cash on Hand
- Set up initial value.
- Create transactions (see 2.5 for balance rules).
- List recent (within the month) transactions.

### 3.3 Cash in Bank
- Set up account (Bank Name, Description, Account Number, Account Name, Beginning Balance, Current Balance).
- Create transactions: deposits, withdrawals, incoming/outgoing transfers (including own-account-to-own-account, which posts two linked entries per rule 2.5), and payments made from the account.
- List recent (within the month) transactions.

### 3.4 Investments
- Set up account (Broker Name, Description, Account Number, Account Name, Beginning Balance, Current Balance).
- Create transactions: buy, sell, dividend/interest received.
- List recent (within the month) transactions.

### 3.5 Loans
- Set up loan (Lender Name, Description, Loan Number, Loan Amount, Loan Balance, Loan Term, Interest Rate, Minimum Payment, Due Date).
- Create payment transactions (partial or full), always linked to a source account per rule 2.5.
- List all loan payment transactions.

### 3.6 Credit Cards
- Set up card (Issuer Name, Description, Credit Limit, Available Balance, Card Balance, Interest Rate, Minimum Payment, Cut-off Date, Due Date).
- Create transactions: purchases (increase Card Balance, decrease Available Balance) and bill payments (linked to a source account per rule 2.5).
- List recent (within the month) transactions.

### 3.7 Utilities
- Set up utility (Provider Name, Description, Service Account Number, Service Account Name, Service Fee, Cut-off Date, Due Date).
- Create payment transactions, linked to a source account.
- List recent (within the month) transactions.
- **Recurring generation** (new): backed by a Recurring Rule (2.7) tied to this Utility. Given the Cut-off/Due Date and schedule, the system auto-drafts the next expected transaction as a **Pending Confirmation** item requiring one-tap user confirmation before it posts and affects balances — it never posts silently.

### 3.8 Income Sources
- Set up source (Source Name, Description, Income Category, Gross Amount, Pay Schedule, Credit To). No per-source Currency field — see 4.2.
- Income Categories: Salaries, Bonuses, Consulting Fees, Dividends, Interests, Capital Gains, Allowances, Tax Credits.
- Pay Schedules: Annually, Quarterly, Monthly, Bi-Monthly, Variable.
- Create income transactions; list recent (within the month) transactions.
- Recurring generation per schedule — auto-drafted, confirmation required before posting (same behavior as 3.7).

### 3.9 Taxes & Other Regulatory Fees
- Set up fee (Regulatory Name, Description, Fee Category, Fee Amount, Fee Schedule, Debit From). No per-fee Currency field — see 4.2.
- Fee Schedules: Annually, Quarterly, Monthly, Bi-Monthly, Variable.
- Create fee transactions; list recent (within the month) transactions.
- Recurring generation per schedule — auto-drafted, confirmation required before posting (same behavior as 3.7).

### 3.10 Financial Goals (new — was referenced but unspecified in v1)
- **Goal Type**: Debt Payoff, Emergency Fund, Savings Target, Investment Target.
- **Target Amount**, **Target Date**.
- **Linked Account(s)**: which account(s) count toward this goal. An account may be linked to more than one goal (e.g., one bank account backing both an Emergency Fund and a Vacation goal); in that case, each goal also stores an **Allocation** — either a fixed amount or a percentage of the account's balance — so progress bars split the same balance rather than each independently claiming the full amount. **Validation** (new): the system tracks total allocation per account across all its linked goals and blocks saving a new/edited allocation that would push the sum past 100% of the account's Current Balance, with a clear error naming the conflicting goal(s). If a linked account is closed (2.1), the goal is flagged for the user to re-link or retire.
- **Strategy** (for debt payoff): Snowball (smallest balance first) or Avalanche (highest interest first) — user-selectable, with **Snowball as the default** (favors early psychological wins to sustain motivation). Avalanche remains fully available and works end-to-end since Interest Rate is a required field on Loan/Credit Card accounts (2.1).
- **Multi-debt allocation** (new): when a Debt Payoff goal links more than one Loan/Card account, the user sets a **Total Monthly Payment Budget** for the goal. The system ranks the linked debts by the chosen strategy (ascending balance for Snowball, descending interest rate for Avalanche), applies each account's own **Minimum Payment** (2.1) first, then directs 100% of any remaining budget to the top-ranked debt until it's paid off, at which point its payment amount rolls onto the next-ranked debt (the classic "snowball/avalanche rolldown"). This is what turns the strategy label into an actual allocation plan rather than just a sort order.
- Progress tracking: current amount vs. target, projected completion date at current pace.
- Dashboard widget showing active goals and progress bars.

### 3.11 AI Analysis (new — was referenced but unspecified in v1)
- **Trigger**: on-demand ("Analyze my finances now") and optionally scheduled (e.g., monthly). Because this is bring-your-own-key (below) and each run is a real charge to the user's own account, a scheduled run does **not** fire automatically by default — it surfaces as a one-tap "Your monthly analysis is ready to run" prompt that the user confirms, same pattern as Pending Confirmation recurring transactions (2.7). A settings toggle allows fully automatic scheduled runs for users who accept that tradeoff, but that's opt-in, not the default.
- **Inputs**: account balances, transaction history, spending categories, active goals.
- **Outputs**:
  - Written summary of current financial standing (income vs. expenses, debt-to-income, savings rate).
  - Concrete plan to reach each active goal (e.g., suggested monthly debt payment, projected payoff date, spending categories to trim).
  - Flags/alerts for unusual spending or upcoming cash shortfalls.
  - **Money-pit flags**, sourced from Spending Pattern Detection (3.11a) rather than computed fresh each run — the AI narrates what the pattern engine already found rather than re-deriving it from raw transactions every time.
- **AI Provider (decided)**: v1 uses an **external AI API** (e.g., Anthropic/OpenAI) rather than a locally-run model, prioritizing analysis quality over keeping data fully on-device. Because this is a self-hosted app handling sensitive financial data, this must be disclosed clearly to the user — not a silent default — with an explicit opt-in during setup, a visible indicator whenever data is sent externally, and a settings toggle to disable AI analysis entirely if the user doesn't want their data leaving the self-hosted instance.
- **Data minimization**: the request sent to the external API is an **aggregated/scrubbed view**, not raw records — account balances, category-level spending totals, and goal progress, with account numbers, institution names, and free-text transaction descriptions stripped out before the call. The AI never needs "Chase account #4471" to give useful advice, only "a bank account with $X balance."
- **API key custody**: v1 is **bring-your-own-key** — the user supplies their own API key for their chosen provider (stored in Settings, 2.0, encrypted at rest). ClearPath AI does not proxy or subsidize API usage, keeping cost and provider relationship directly with the user.
- **Failure/cost handling**: on API error, rate limit, or timeout, the analysis fails gracefully with a clear in-app message and no partial/misleading output — it does not retry silently or fall back to fabricated analysis. Since the user pays for their own API usage, the settings page shows basic visibility (last call date, call count) so cost isn't a surprise; it does not attempt to track exact dollar cost, which varies by provider.

### 3.11a Spending Pattern Detection ("Money Pits")

Distinct from the on-demand AI Analysis above: this runs entirely on the app's **own transaction data** (no external API call needed), continuously as data accumulates, and surfaces patterns worth a second look — the AI Analysis then narrates these in plain language when it runs.

- **Category trend detection**: flags a Spending Category (2.4) whose rolling monthly total has grown significantly versus its own trailing average (e.g., "Groceries" up 40% over 3 months) — surfaces the trend, not a judgment about whether it's a problem.
- **Recurring-charge clustering**: groups transactions by similar Description/Amount/cadence to surface likely subscriptions the user may not think of as a single line item — e.g., four separate "AI subscription"-tagged charges totaling $60/month, even if they're never manually flagged as a subscription individually.
- **What this can and cannot tell the user**: the engine can reliably report *cost and frequency* — how much a category or recurring charge costs and how often it recurs. It **cannot** determine whether a subscription is underutilized, because ClearPath AI only tracks money movement, not usage of the service being paid for. Money-pit flags are phrased accordingly ("you're spending $60/month across 4 AI subscriptions" rather than "you're not using these enough") unless the user has manually tagged a recurring charge with a personal utilization note.
- **Data requirement**: category trend and recurring-charge detection need a meaningful history to be reliable — the feature is inactive (not guessing) until roughly 3 months of transaction data exists, and says so in-app rather than surfacing noisy false positives early on.
- **Surfacing**: money-pit flags appear on the Dashboard (3.1) as a dismissible list, independent of whether the user has AI Analysis (3.11) enabled — this works without an external API key, only the AI *narration* of the flags depends on 3.11 being configured.

---

## 4. Cross-Cutting Requirements (new — not in v1)

### 4.1 Bank Statement Import
Manual entry of every transaction is a major adoption barrier. Support CSV/OFX import for bank and card transactions, with a review step before posting.

### 4.2 Currency (decided)
v1 supports a **single base currency**, set once during initial setup. The `Currency` field is removed from Income Sources and Taxes/Regulatory Fees (2.4/3.8/3.9) for consistency with every other module, which never had one. Multi-currency support (conversion rates, per-account currency) is deferred to a future version.

### 4.3 Security
- Encryption at rest for the database, particularly account numbers and balances.
- Authentication/passphrase required even for single-user local deployments, given data sensitivity.
- Backup/restore tooling, since the user is responsible for their own self-hosted data durability. **Secrets handling** (new): the Settings record (2.0) holds encrypted secrets — the AI API key and SMTP credentials. Backups include them (still encrypted, never decrypted-in-place in the backup file) so a restore doesn't silently drop AI/notification configuration; the backup file itself should be treated by the user as sensitive, and the restore flow surfaces a reminder to re-verify/rotate keys after restoring to a new instance.
- **Transit encryption** (new): HTTPS/TLS required for the web app itself, and for all outbound calls to the external AI API (3.11) — data leaving the self-hosted instance, whether to the browser or to the AI provider, is never sent in plaintext.

### 4.4 Data Export
Distinct from backup/restore (which is a full-system dump for disaster recovery). Users can export their own records as CSV or PDF statements, scoped by account and date range, for tax filing, loan applications, or personal recordkeeping.

### 4.5 Notifications
Upcoming dues (loans, cards, utilities, taxes) and pending recurring transactions (2.7/3.7) need a delivery channel, not just a dashboard listing. v1 scope: in-app banner/badge plus optional email reminder. Lead time uses the global Default Reminder Lead Time (2.0) unless a specific item overrides it. Since a self-hosted instance has no built-in mail server, email delivery requires the user to supply their own SMTP credentials in Settings (2.0). Push notifications are a future consideration pending whether ClearPath AI ships a mobile client.

### 4.6 Spending Category Management
Categories (2.4) are user-editable. Rules:
- **Rename**: applies retroactively — all historical transactions tagged with the category display the new name.
- **Merge**: two categories combined into one; historical transactions are re-tagged to the surviving category.
- **Delete**: only allowed if no transactions reference it, or the user is prompted to reassign existing transactions to another category first. Categories are never left orphaned on historical data.

---

## 5. v1 Scope Decisions Log

All prior open decisions have been resolved for v1:

| Decision | Resolution | Ref |
|---|---|---|
| AI analysis provider | External AI API, with explicit user opt-in and a visible indicator/toggle | 3.11 |
| Default debt payoff strategy | Snowball, with Avalanche available as an alternative | 3.10 |
| Currency scope | Single base currency only | 4.2 |
| Investment valuation | Cost Basis only; Market Value deferred indefinitely | 2.4a |
| Loan/Card interest split | Manual entry (with an interest-rate-suggested pre-fill); amortization auto-calculation deferred | 2.4a |
| Settings/User model | Added — single Settings record for currency, auth, AI key, SMTP config | 2.0 |
| Recurring transaction backing | Added — Recurring Rule entity generates Pending Confirmation transactions | 2.7 |
| AI data sent externally | Scrubbed/aggregated view only; no account numbers or free-text descriptions | 3.11 |
| AI API key custody | Bring-your-own-key, user-supplied and encrypted at rest | 3.11 |
| Multi-debt payoff allocation | Budget-based rolldown across linked debts, ranked by strategy | 3.10 |
| Snapshot job resilience | Missed-run back-fill from transaction history on next login | 3.1 |
| Recurring Rule job resilience | Missed-run catch-up generates one draft per missed cycle | 2.7 |
| Card/Loan interest posting | Never auto-posted; user enters it manually via Interest Portion when it appears on statement | 2.4b |
| Minimum Payment data | Added field on Account (Loan/Credit Card), feeds allocation and upcoming-dues | 2.1 |
| Upcoming dues data source | Unified: Account Due Date for Loans/Cards, Recurring Rule Next Run Date for others | 3.1 |
| Reminder lead time | Global default in Settings, overridable per item | 2.0/4.5 |
| Scheduled AI analysis cost | Requires one-tap confirmation by default; full auto-run is opt-in | 3.11 |
| Goal allocation over-commit | Blocked — total allocation per account across goals can't exceed 100% | 3.10 |
| Transfer fee handling | Debited from source account only; destination always receives full Amount | 2.5 |
| Settings secrets in backup | Included, still encrypted; restore flow prompts key/credential re-verification | 4.3 |
| Money-pit / spending-pattern detection | Added — local (non-API) category-trend and recurring-charge clustering; explicitly can't detect "underutilization," only cost/frequency | 3.11a |

No open decisions remain blocking a v1 build. Future-version candidates (multi-currency, Market Value tracking, amortization schedules, local AI model option, mobile push notifications) are noted inline at their respective sections above.
