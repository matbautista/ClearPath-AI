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
| Architecture | MVVM + Repository | Keeps the 8 core modules' "all update shared balances" logic testable and out of the Views |
| AI analysis | **Apple's on-device Foundation Models framework** (iOS 26+ — the developer-facing framework, not just Apple Intelligence being present on-device; verify against current Apple docs before locking the deployment target) | Since data must stay local, this is the only option that gives you real LLM-style reasoning without a network call. Fallback: a rules-based analysis engine you write yourself (see Phase 5) |
| Local auth | Face ID / Passcode (LocalAuthentication framework) | This app holds a full financial picture — lock it behind biometrics by default |
| Deployment target | iOS 17.x (SwiftData's minimum), independent of the AI feature's higher requirement | The app itself (SwiftData, Swift Charts, LocalAuthentication) only needs iOS 17+; keeping this decoupled from Foundation Models' iOS 26+ requirement is what makes the Phase 5 fallback possible at all |

No backend, no API keys, no third-party financial data services needed for v1. This keeps the whole project buildable in Xcode/Simulator — though Face ID and Foundation Models both need a physical device to fully validate, since Simulator only fakes biometric enrollment and doesn't reflect real on-device model availability.

---

## 2. Core Data Model

Everything in your spec collapses into a handful of SwiftData models. The key insight from your spec: **every module (Cash, Bank, Investments, Loans, Cards, Utilities, Income, Taxes) is really just "an account/source" that owns a stream of `Transaction`s**, and the dashboard is just aggregation over those.

```
Account (protocol-like base concept, implemented per type — every concrete type below carries `status: open/closed`, decided once in Phase 0 rather than bolted on per-type later; on `CashWallet` specifically this is vestigial and always `open`, since there's exactly one instance and no real-world "closing" concept for physical cash on hand — keep it for schema uniformity, not because it does anything there)
├── CashWallet          (single instance: current cash-on-hand balance)
├── BankAccount          (Bank Name, Account #, Account Name, Beginning/Current Balance)
├── InvestmentAccount    (Broker, Account #, Beginning/Current Balance)
├── Loan                 (Lender, Loan #, Principal, Balance, Interest Rate, Term, Due Date → RecurringSchedule)
├── CreditCard           (Issuer, Limit, Available/Card Balance, Interest Rate, Cut-off → RecurringSchedule, Due Date → RecurringSchedule)
├── Utility              (Provider, Service Acct #, Fee, Cut-off → RecurringSchedule, Due Date → RecurringSchedule)
├── IncomeSource         (Source Name, Category, Gross Amount, Currency, Pay Schedule → RecurringSchedule)
└── TaxFee               (Regulatory Name, Category, Amount, Currency, Fee Schedule → RecurringSchedule)

**`status` belongs on the shared `Account` concept, decided in Phase 0.** A fully-paid-off loan, a closed card, or a bank/investment account the user closes out shouldn't disappear (that destroys transaction history) or get deleted (that risks cascading the delete into its transactions, depending on the relationship delete rule chosen). Add an explicit `open`/`closed` status to every account type from the start — not just Loan/CreditCard — since `BankAccount` ships in Phase 1, a full phase before any per-type retrofit would happen, and adding it later is exactly the kind of structural schema change that's expensive once real data exists (see §5). Closed accounts drop out of active dashboard totals and "upcoming dues" but stay queryable in history. Note `Loan` and `CreditCard` reach `closed` differently: a `Loan` naturally transitions when `Balance` hits zero via full payoff, but a `CreditCard` can be closed by user action while `Card Balance` is still nonzero (a cancelled card being paid down) — closing a card must not require a zero balance, and a closed-but-still-owed card should keep counting toward both debt totals *and* "upcoming dues" — not just totals — until its balance actually reaches zero, since the user still owes a scheduled payment on it regardless of its `closed` status.

**Interest Rate on Loan/CreditCard.** Phase 5's rules engine names "debt-avalanche" as one of its calculations, and avalanche specifically orders debts by interest rate to minimize total interest paid — it cannot be computed without a rate field on both entities. (Snowball, which orders by balance, would work without it, but the plan names both.) Add it now rather than discovering the gap when Phase 5 tries to implement avalanche against a schema with nowhere to read a rate from.

**`CashWallet` single-instance enforcement.** The CloudKit-compat guidance above means avoiding a unique constraint, so nothing in the schema itself stops a second row from being created. Enforce this at the app layer instead: always fetch-or-create the one instance in the repository, and never expose an "add" affordance for it in the UI.

**Polymorphism decision (settle in Phase 0).** SwiftData `@Model` relationships must point to a concrete type — you can't relate a `Transaction` to a protocol, and SwiftData's class-inheritance support for polymorphic queries is still unreliable in practice. Before writing the schema, pick one:
  (a) give `Transaction.mode` and `FinancialGoal.linkedAccounts` a separate optional relationship field per account type (8 nullable fields) and aggregate manually in the repository layer, or
  (b) use a real class-inheritance hierarchy for `Account` and accept its rough edges (migration fragility, iffy fetch-descriptor support).
  Option (a) is more boilerplate but far more predictable — recommended default unless you've already prototyped (b) successfully.

**Currency field consistency.** Only `IncomeSource`/`TaxFee` carry an explicit `currency` field above — decide now whether this app is single-currency (in which case drop `currency` from those two and keep it implicit app-wide) or genuinely multi-currency (in which case every `Account` type and `Transaction` needs the field, plus a conversion strategy for the Dashboard's aggregated totals). Partial multi-currency support is a common source of silent scope creep — pick one path in Phase 0 and apply it uniformly.

Transaction
├── description: String
├── date: Date
├── amount: Decimal
├── additionalFees: Decimal
├── totalAmount: Decimal (computed: amount + fees)
├── indicator: enum { debit, credit }
├── mode: relationship → one of the Account types above (or .cash)
├── category: enum { bills, billsPayment, cashPayment, cashDeposit, checkDeposit, cashWithdrawal, eCashTransfer, eCashPayment, ... }
│     — this list only covers Phase 1's cash/bank needs. Treat it as open, not closed: Phase 2 needs cases for card purchases/payments and loan payments, Phase 4 needs buy/sell/dividend, and recurring modules need income/tax/utility payment cases. Extend it per-phase rather than trying to finalize it now.
└── linkedTransactionID: UUID? (used for the paired debit/credit legs described below)
    — no soft-delete field: deleting a Transaction is permanent. That's a deliberate v1 simplicity call, not an oversight — revisit only if losing history to an accidental delete turns out to matter in practice.

RecurringSchedule
├── frequency: enum { monthly, quarterly, biMonthly, annually, variable }
├── anchorDate: Date (the first/reference occurrence)
└── nextDueDate: Date (computed from anchorDate + frequency, or overridden for `variable`)
    — introduced in Phase 2 for Loan/CreditCard `Due Date`/`Cut-off` (both recur monthly), generalized in Phase 3 for Utilities/Income/Taxes. Define it here rather than inline on each entity so all seven use sites (Loan.DueDate, CreditCard.DueDate, CreditCard.CutOff, Utility.DueDate, Utility.CutOff, IncomeSource.PaySchedule, TaxFee.FeeSchedule) share one component from the start.

FinancialGoal
├── name, targetAmount, targetDate, goalType (debtPayoff / emergencyFund / investment)
├── linkedAccounts: [Account] (e.g. link a goal to a specific Loan to track payoff progress)
├── achieved: Bool, completedDate: Date? (trigger differs by `goalType`: `debtPayoff` sets it when **every** account in `linkedAccounts` reaches `closed` status — `linkedAccounts` is an array, so a goal spanning multiple loans/cards shouldn't complete until all of them are paid off, not just the first one; `emergencyFund`/`investment` have no linked Loan to key off, so they need their own trigger — linked account balance reaching `targetAmount` — which isn't yet specified anywhere else in this doc and should be nailed down in Phase 5)
```

**`linkedAccounts` can dangle.** Same class of problem as the linked-transaction integrity issue above: if a `Loan` (or any linked `Account`) is deleted outright rather than transitioned to `closed`, a `FinancialGoal` referencing it is left pointing at nothing. Once `status` exists (see above), steer deletion UI toward "close" for accounts with goal references, and treat outright deletion of a goal-linked account as something the repository layer actively guards against rather than allows silently.

**Important design decision — double-entry transfers.** Your spec calls out that transfers between your own accounts (bank-to-bank, cash withdrawal from bank) must create **two linked transactions** (a debit leg and a credit leg). Model this as a `TransferService` that always writes both `Transaction` rows atomically and stamps them with the same `linkedTransactionID`, so a transfer can never exist as an orphaned single-sided entry. This is the single trickiest piece of business logic in the whole app — get this right early since almost every module depends on it (cash↔bank, bank↔bank, bank↔card payment, bank↔loan payment).

**Integrity of the linked legs after creation.** A bare `linkedTransactionID: UUID?` match only protects atomicity at *write* time — it does nothing to stop a user from deleting or editing a single leg later from an ordinary transaction list screen, which reintroduces the exact orphaned-single-sided-entry problem `TransferService` exists to prevent. Two ways to close this gap, either is acceptable but pick one deliberately: (a) model `Transfer` as its own lightweight entity owning two `Transaction` children via a real SwiftData relationship, so a cascade-delete rule enforces both-or-neither at the persistence layer; or (b) keep the UUID-matching design but make every edit/delete entry point in the UI detect `linkedTransactionID != nil` and operate on both legs together, with no code path that touches one leg alone. Whichever you pick, cover it with the same unit tests planned for `TransferService`'s creation path.

---

## 3. App Structure (Screens)

Maps to your spec's 8 core modules, plus Dashboard, Goals, and AI Insights layered on top:

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
- Xcode project, SwiftData schema for all models above, including the shared `status: open/closed` field on every `Account` type and the `RecurringSchedule` entity (see §2) — settle both now since `BankAccount` (Phase 1) and `Loan`/`CreditCard` (Phase 2) both depend on them existing from the start
- App-wide `Decimal`-based currency formatting (never use `Double` for money)
- Face ID lock screen
- Set up the unit test target now, not later — for a finance app, tests are cheapest to write alongside the code they cover instead of retrofitted

**Phase 1 — Cash & Bank (simplest two modules, and where the transfer logic gets proven out)**
- Cash on Hand: setup + manual transactions
- Bank Accounts: setup + transactions
- Build `TransferService` here (cash↔bank, bank↔bank) since it's needed immediately, and unit test it thoroughly (paired-leg creation, atomicity, no orphaned single-sided entries) — this is the highest-value test coverage in the whole app since every other module depends on it being correct
- Basic Dashboard showing just these two totals

**Phase 2 — Credit Cards & Loans**
- Credit card setup, purchase tracking, payment tracking. `Available Balance` should be computed live as `Limit - Card Balance`, not stored independently — same live-compute/cache-for-display rule as everywhere else (see §5, Balance drift)
- Loan setup, payment tracking, partial vs. full payoff logic, `open`/`closed` status transition on full payoff (see §2)
- Extend `TransferService` (built in Phase 1) to cover bank↔card payment and bank↔loan payment as linked-transaction pairs — these are the same atomic double-entry pattern, not a new one-off implementation
- **`Loan.Due Date` and `CreditCard.Due Date`/`Cut-off` are all inherently recurring (monthly), but the shared `RecurringSchedule` component isn't scheduled until Phase 3.** Use the minimal `RecurringSchedule` entity defined in §2 for these fields here instead of inventing ad hoc day-of-month fields that Phase 3 would otherwise need to throw away and redo
- Extend Dashboard with these totals + "upcoming dues" (needs Due Date across Cards/Loans/Utilities)

**Phase 3 — Recurring modules**
- Utilities, Income Sources, Taxes & Regulatory Fees
- These share a "recurring schedule" concept (Monthly/Quarterly/Bi-Monthly/Annually/Variable) — generalize the minimal `RecurringSchedule` component pulled forward in Phase 2 rather than building it from scratch here
- Optional: local notifications for upcoming due dates

**Phase 4 — Investments**
- Investment account setup, buy/sell/dividend transactions
- Dividend transactions: decide whether they land in-place as an investment-account balance increase, or route through `TransferService` if they're paid out to a linked bank account — pick one and apply it consistently, don't let it vary per transaction
- Performance view: a naive current-vs-beginning-balance comparison is misleading once contributions/withdrawals exist (a $10k deposit reads as a 100% "gain"). Either net out contributions/withdrawals before comparing, or scope this view down to "balance over time" and explicitly defer real return calculation

**Phase 5 — Goals + AI Analysis**
- Goal setup UI (debt payoff, emergency fund, investing targets)
- Analysis engine: start with a **rules-based version first** (e.g. debt-avalanche/snowball calculation, months-to-emergency-fund based on average monthly expenses over a trailing 3-month window — long enough to smooth one-off spending spikes, short enough to react to a real change in habits — surplus-to-invest calculation) — this works offline with zero AI dependency and is easy to unit test. **"Expenses" must exclude `TransferService`-created linked-transaction legs** (any `Transaction` with `linkedTransactionID != nil`) — a naive sum of debits would double-count every bank↔bank/bank↔card/bank↔loan transfer as spending, when the money never actually left the household. Unit test the rules engine itself (avalanche/snowball math, months-to-goal projections, and the transfer-exclusion filter) — these are pure functions and cheap to cover exhaustively
- Layer the on-device Foundation Models framework on top to turn the rules-engine output into a natural-language plan/narrative, since the raw math is more trustworthy coming from your own deterministic code than from a model. Treat this layer as fully optional, not a Phase 5 blocker: Foundation Models requires iPhone 15 Pro+ hardware **and iOS 26+** — meaning any device on an older OS falls back too, not just older hardware — so on unsupported devices, including possibly your own primary device for a while, "AI Insights" should silently and permanently show the rules-based narrative with no degraded/broken state to fix later

**Phase 6 — Polish**
- Full Dashboard (all totals + upcoming dues sorted by date)
- Charts (spending by category, net worth trend, debt payoff trajectory)
- CSV export **and full JSON backup/restore** — not just "nice to have." This app is the only copy of someone's full financial picture with no backend; without an explicit, human-triggerable export/restore path, the only safety net is an implicit iCloud device backup, which won't help against SwiftData corruption, an accidental delete, or moving to a new device before a backup runs. Treat backup/restore as a Phase 6 requirement, not a stretch goal
- The JSON backup file itself must be encrypted or password-protected before it can land in Files/iCloud Drive/AirDrop — an app that's biometric-locked on-device but exports a plaintext dump of the user's full financial picture undermines its own security model
- App Store screenshots/listing if you intend to publish

---

## 5. Key Risks to Watch

- **Money math**: use `Decimal`, never `Double`/`Float`, anywhere currency is stored or calculated — floating point rounding errors will corrupt balances over time.
- **Balance drift**: because every module maintains a running balance (Current Balance, Available Balance, Card Balance, etc.) that's *derived* from transactions, decide early whether balances are (a) stored fields updated on each transaction write, or (b) always computed live from the transaction log. Recommendation: compute live from the transaction log for correctness, and cache for display performance — storing a mutable running balance that can drift out of sync with its transactions is the most common bug source in finance apps.
- **On-device AI availability**: Foundation Models framework requires Apple Intelligence–capable hardware (iPhone 15 Pro and later) **and iOS 26+** — the framework is a developer API introduced in iOS 26, distinct from Apple Intelligence merely existing on-device since iOS 18.1. Plan a graceful fallback to the rules-based engine on unsupported devices *and* unsupported OS versions.
- **No backend means no safety net**: with 100% on-device storage and no cloud sync, a corrupted SwiftData store, accidental delete, or lost/replaced device means permanent data loss unless an explicit export/backup path exists (see Phase 6). Don't let this slip to "someday" — it's the single highest-consequence gap for a finance app.
- **Untested money logic compounds silently**: `TransferService` and the rules-based analysis engine are the two places a subtle bug corrupts numbers a user trusts without any visible error. Cover both with unit tests as they're built (Phase 1 and Phase 5), not retroactively.
- **Schema evolves across ~6 phases with real user data at stake**: SwiftData's lightweight migration only handles additive changes gracefully; the Phase 0 polymorphism decision and the linked-transaction modeling (see §2) are exactly the kind of structural choices that are expensive to reverse once Phase 1+ data exists. Snapshot schema versions as you go rather than treating migration as a Phase 6 afterthought.

---

## 6. Suggested First Milestone

Given no rush, the highest-value first milestone is **Phase 0 + Phase 1**: get Cash + Bank + the transfer logic fully working with a minimal dashboard. That's the piece every other module depends on, and once it's solid, Phases 2–4 are largely repetitive variations on the same pattern (setup screen → transaction list → balance aggregation).
