# Personal Finance iOS App — Development Plan

**Platform:** iOS only
**Storage:** 100% on-device, no backend, no cloud sync
**Pace:** Solo project, incremental, no deadline pressure

---

## 1. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | Swift | Native, required for the below |
| UI | SwiftUI | Fastest way to build the dashboard/list-heavy screens this app needs |
| Persistence | **SwiftData** | Apple's modern on-device ORM (built on Core Data). Since there's no backend, this removes the need to hand-roll sync/serialization logic. Design the schema to stay CloudKit-compatible from day one (avoid unique constraints, give every relationship a default/optional value) — costs nothing now, but keeps a future opt-in iCloud sync (e.g. for device migration or an iPad companion) a config change instead of a migration project |
| Charts | Swift Charts | Native, free, integrates directly with SwiftData query results |
| Architecture | MVVM + Repository | Keeps the "12 modules that all update shared balances" logic testable and out of the Views |
| AI analysis | **Apple's on-device Foundation Models framework** (iOS 18.2+) | Since data must stay local, this is the only option that gives you real LLM-style reasoning without a network call. Fallback: a rules-based analysis engine you write yourself (see Phase 5) |
| Local auth | Face ID / Passcode (LocalAuthentication framework) | This app holds a full financial picture — lock it behind biometrics by default |

No backend, no API keys, no third-party financial data services needed for v1. This keeps the whole project buildable and testable entirely in Xcode/Simulator.

---

## 2. Core Data Model

Everything in your spec collapses into a handful of SwiftData models. The key insight from your spec: **every module (Cash, Bank, Investments, Loans, Cards, Utilities, Income, Taxes) is really just "an account/source" that owns a stream of `Transaction`s**, and the dashboard is just aggregation over those.

```
Account (protocol-like base concept, implemented per type)
├── CashWallet          (single instance: current cash-on-hand balance)
├── BankAccount          (Bank Name, Account #, Account Name, Beginning/Current Balance)
├── InvestmentAccount    (Broker, Account #, Beginning/Current Balance)
├── Loan                 (Lender, Loan #, Principal, Balance, Term, Due Date)
├── CreditCard           (Issuer, Limit, Available/Card Balance, Cut-off, Due Date)
├── Utility              (Provider, Service Acct #, Fee, Cut-off, Due Date)
├── IncomeSource         (Source Name, Category, Gross Amount, Currency, Pay Schedule)
└── TaxFee               (Regulatory Name, Category, Amount, Currency, Fee Schedule)

**Currency field consistency.** Only `IncomeSource`/`TaxFee` carry an explicit `currency` field above — decide now whether this app is single-currency (in which case drop `currency` from those two and keep it implicit app-wide) or genuinely multi-currency (in which case every `Account` type and `Transaction` needs the field, plus a conversion strategy for the Dashboard's aggregated totals). Partial multi-currency support is a common source of silent scope creep — pick one path in Phase 0 and apply it uniformly.

Transaction
├── description: String
├── date: Date
├── amount: Decimal
├── additionalFees: Decimal
├── totalAmount: Decimal (computed: amount + fees)
├── indicator: enum { debit, credit }
├── mode: relationship → one of the Account types above (or .cash)
├── category: enum { bills, billsPayment, cashPayment, cashDeposit, checkDeposit, cashWithdrawal, eCashTransfer, eCashPayment }
└── linkedTransactionID: UUID? (used for the paired debit/credit legs described below)

FinancialGoal
├── name, targetAmount, targetDate, goalType (debtPayoff / emergencyFund / investment)
├── linkedAccounts: [Account] (e.g. link a goal to a specific Loan to track payoff progress)
```

**Important design decision — double-entry transfers.** Your spec calls out that transfers between your own accounts (bank-to-bank, cash withdrawal from bank) must create **two linked transactions** (a debit leg and a credit leg). Model this as a `TransferService` that always writes both `Transaction` rows atomically and stamps them with the same `linkedTransactionID`, so a transfer can never exist as an orphaned single-sided entry. This is the single trickiest piece of business logic in the whole app — get this right early since almost every module depends on it (cash↔bank, bank↔bank, bank↔card payment, bank↔loan payment).

---

## 3. App Structure (Screens)

Maps directly to your spec's 8 sections:

1. **Dashboard** — read-only aggregation screen (cash on hand, total bank, total loan balance, total card balance, upcoming dues). Built last within each phase, since it just queries the modules below.
2. **Cash on Hand** — single balance + transaction list
3. **Cash in Bank** — multi-account list → account detail → transactions
4. **Investments** — multi-account list → account detail → transactions
5. **Loans** — multi-loan list → loan detail → payment transactions → payoff tracking
6. **Credit Cards** — multi-card list → card detail → purchases/payments
7. **Utilities** — provider list → transactions
8. **Income Sources** — source list → transactions
9. **Taxes & Regulatory Fees** — fee list → transactions
10. **Goals** — goal setup + progress tracking
11. **AI Insights** — analysis + recommended plan

---

## 4. Phased Roadmap (no deadlines — sequenced by dependency)

Since there's no team and no rush, phases are ordered so each one is a fully working, testable slice — you can stop after any phase and have something functional.

**Phase 0 — Foundation**
- Xcode project, SwiftData schema for all models above
- App-wide `Decimal`-based currency formatting (never use `Double` for money)
- Face ID lock screen
- Set up the unit test target now, not later — for a finance app, tests are cheapest to write alongside the code they cover instead of retrofitted

**Phase 1 — Cash & Bank (simplest two modules, and where the transfer logic gets proven out)**
- Cash on Hand: setup + manual transactions
- Bank Accounts: setup + transactions
- Build `TransferService` here (cash↔bank, bank↔bank) since it's needed immediately, and unit test it thoroughly (paired-leg creation, atomicity, no orphaned single-sided entries) — this is the highest-value test coverage in the whole app since every other module depends on it being correct
- Basic Dashboard showing just these two totals

**Phase 2 — Credit Cards & Loans**
- Credit card setup, purchase tracking, payment tracking (auto-updates Available Balance & Card Balance)
- Loan setup, payment tracking, partial vs. full payoff logic
- Extend Dashboard with these totals + "upcoming dues" (needs Due Date across Cards/Loans/Utilities)

**Phase 3 — Recurring modules**
- Utilities, Income Sources, Taxes & Regulatory Fees
- These share a "recurring schedule" concept (Monthly/Quarterly/Bi-Monthly/Annually/Variable) — build one shared `RecurringSchedule` component instead of three copies
- Optional: local notifications for upcoming due dates

**Phase 4 — Investments**
- Investment account setup, buy/sell/dividend transactions
- Simple performance view (current vs. beginning balance)

**Phase 5 — Goals + AI Analysis**
- Goal setup UI (debt payoff, emergency fund, investing targets)
- Analysis engine: start with a **rules-based version first** (e.g. debt-avalanche/snowball calculation, months-to-emergency-fund based on average monthly expenses, surplus-to-invest calculation) — this works offline with zero AI dependency and is easy to unit test. Unit test the rules engine itself (avalanche/snowball math, months-to-goal projections) — these are pure functions and cheap to cover exhaustively
- Layer the on-device Foundation Models framework on top to turn the rules-engine output into a natural-language plan/narrative, since the raw math is more trustworthy coming from your own deterministic code than from a model. Treat this layer as fully optional, not a Phase 5 blocker: Foundation Models requires iPhone 15 Pro+ and iOS 18.1+, so on older/unsupported hardware — including possibly your own primary device — "AI Insights" should silently and permanently show the rules-based narrative with no degraded/broken state to fix later

**Phase 6 — Polish**
- Full Dashboard (all totals + upcoming dues sorted by date)
- Charts (spending by category, net worth trend, debt payoff trajectory)
- CSV export **and full JSON backup/restore** — not just "nice to have." This app is the only copy of someone's full financial picture with no backend; without an explicit, human-triggerable export/restore path, the only safety net is an implicit iCloud device backup, which won't help against SwiftData corruption, an accidental delete, or moving to a new device before a backup runs. Treat backup/restore as a Phase 6 requirement, not a stretch goal
- App Store screenshots/listing if you intend to publish

---

## 5. Key Risks to Watch

- **Money math**: use `Decimal`, never `Double`/`Float`, anywhere currency is stored or calculated — floating point rounding errors will corrupt balances over time.
- **Balance drift**: because every module maintains a running balance (Current Balance, Available Balance, Card Balance, etc.) that's *derived* from transactions, decide early whether balances are (a) stored fields updated on each transaction write, or (b) always computed live from the transaction log. Recommendation: compute live from the transaction log for correctness, and cache for display performance — storing a mutable running balance that can drift out of sync with its transactions is the most common bug source in finance apps.
- **On-device AI availability**: Foundation Models framework requires Apple Intelligence–capable hardware (iPhone 15 Pro and later, iOS 18.1+). Plan a graceful fallback to the rules-based engine on unsupported devices.
- **No backend means no safety net**: with 100% on-device storage and no cloud sync, a corrupted SwiftData store, accidental delete, or lost/replaced device means permanent data loss unless an explicit export/backup path exists (see Phase 6). Don't let this slip to "someday" — it's the single highest-consequence gap for a finance app.
- **Untested money logic compounds silently**: `TransferService` and the rules-based analysis engine are the two places a subtle bug corrupts numbers a user trusts without any visible error. Cover both with unit tests as they're built (Phase 1 and Phase 5), not retroactively.

---

## 6. Suggested First Milestone

Given no rush, the highest-value first milestone is **Phase 0 + Phase 1**: get Cash + Bank + the transfer logic fully working with a minimal dashboard. That's the piece every other module depends on, and once it's solid, Phases 2–4 are largely repetitive variations on the same pattern (setup screen → transaction list → balance aggregation).
