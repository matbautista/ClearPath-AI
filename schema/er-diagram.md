# ClearPath AI — Entity-Relationship Diagram

Derived from `ClearPath-AI-Spec-Baseline.md` (v9, closed) and implemented in `schema/schema.sql` (SQLite). Five entities here — `UTILITIES`, `INCOME_SOURCES`, `TAX_FEES`, `NET_WORTH_SNAPSHOTS`, `MONEY_PIT_FLAGS` — were never formalized as tables in the prose spec; they're formalized here for the first time. See the header comment in `schema.sql` for the full list of gaps this translation surfaced.

## Diagram

```mermaid
erDiagram
    SETTINGS {
        int id PK "always 1 — single row"
        text base_currency
        int ai_analysis_enabled
        text ai_provider
        int default_reminder_lead_time_days
    }

    ACCOUNTS {
        int id PK
        text account_type "Cash | Bank | Investment | Loan | CreditCard"
        text account_name
        int beginning_balance_minor
        int current_balance_minor "cached; not CreditCard"
        int card_balance_minor "cached; CreditCard only"
        real interest_rate_pct "Loan/CreditCard"
        int due_date_day "day-of-month"
        text status "Active | Closed"
    }

    SPENDING_CATEGORIES {
        int id PK
        text name UK
        int is_system
    }

    TRANSACTIONS {
        int id PK
        text txn_date
        int amount_minor
        text indicator "Debit | Credit"
        int source_account_id FK
        int destination_account_id FK "mirror, two-leg only"
        text txn_type
        int spending_category_id FK
        text income_category "single-leg inflow only"
        int principal_portion_minor "Loan/Card Payment"
        int interest_portion_minor "Loan/Card Payment"
        int linked_transaction_id FK "paired leg"
        text status "Posted | Voided | PendingConfirmation"
    }

    UTILITIES {
        int id PK
        text provider_name
        int default_account_id FK "gap fix — see schema.sql"
        int due_date_day
    }

    INCOME_SOURCES {
        int id PK
        text source_name
        text income_category
        int credit_to_account_id FK
    }

    TAX_FEES {
        int id PK
        text regulatory_name
        int debit_from_account_id FK
    }

    RECURRING_RULES {
        int id PK
        int utility_id FK "exactly one of these three"
        int income_source_id FK
        int tax_fee_id FK
        text schedule
        int template_amount_minor
        text next_run_date
        int last_generated_transaction_id FK
        int reminder_lead_time_days
    }

    GOALS {
        int id PK
        text goal_type
        int target_amount_minor
        text strategy "DebtPayoff only"
        text status "Active | Completed | Abandoned — cached, derived"
    }

    GOAL_ACCOUNT_LINKS {
        int id PK
        int goal_id FK
        int account_id FK
        text allocation_type "FixedAmount | Percentage"
        real allocation_value
    }

    NET_WORTH_SNAPSHOTS {
        int id PK
        text snapshot_date UK
        int total_assets_minor
        int total_liabilities_minor
        int net_worth_minor
    }

    MONEY_PIT_FLAGS {
        int id PK
        text flag_type "CategoryTrend | RecurringChargeCluster"
        int spending_category_id FK "CategoryTrend only, unique while Active"
        text cluster_key "RecurringChargeCluster only, unique while Active"
        text status "Active | Dismissed"
    }

    MONEY_PIT_FLAG_TRANSACTIONS {
        int flag_id FK
        int transaction_id FK
    }

    AI_ANALYSIS_RUNS {
        int id PK
        text ran_at
        text status "Success | Failed"
        text output_text
    }

    ACCOUNTS ||--o{ TRANSACTIONS : "source_account_id"
    ACCOUNTS |o--o{ TRANSACTIONS : "destination_account_id"
    TRANSACTIONS |o--o| TRANSACTIONS : "linked_transaction_id"
    SPENDING_CATEGORIES |o--o{ TRANSACTIONS : "spending_category_id"

    ACCOUNTS ||--o{ UTILITIES : "default_account_id"
    ACCOUNTS ||--o{ INCOME_SOURCES : "credit_to_account_id"
    ACCOUNTS ||--o{ TAX_FEES : "debit_from_account_id"

    UTILITIES |o--o{ RECURRING_RULES : ""
    INCOME_SOURCES |o--o{ RECURRING_RULES : ""
    TAX_FEES |o--o{ RECURRING_RULES : ""
    RECURRING_RULES |o--o| TRANSACTIONS : "last_generated_transaction_id"

    GOALS ||--o{ GOAL_ACCOUNT_LINKS : ""
    ACCOUNTS ||--o{ GOAL_ACCOUNT_LINKS : ""

    SPENDING_CATEGORIES |o--o{ MONEY_PIT_FLAGS : ""
    MONEY_PIT_FLAGS ||--o{ MONEY_PIT_FLAG_TRANSACTIONS : ""
    TRANSACTIONS ||--o{ MONEY_PIT_FLAG_TRANSACTIONS : ""
```

## Reading this diagram

- **`ACCOUNTS` is the hub.** Every module in the spec (Cash, Bank, Investment, Loans, Credit Cards) is one `account_type` row here (2.1) — that's the whole point of the "unified Account model."
- **`TRANSACTIONS` referencing itself** (`linked_transaction_id`) is the two-leg structure from §2.2: a transfer, buy/sell, loan/card payment, or disbursement is two independent rows pointing at each other, not one row with two account columns.
- **`SETTINGS`, `NET_WORTH_SNAPSHOTS`, `AI_ANALYSIS_RUNS`** have no foreign keys in or out — they're singleton/log tables, not part of the relational graph.
- **Dotted vs. solid connector ends**: `|o` = optional (zero-or-one), `||` = mandatory (exactly-one), `o{` = zero-or-many, `{` alone = one-or-many. `ACCOUNTS |o--o{ TRANSACTIONS` (destination) is optional both ways because most transactions are single-leg.

## Resolved since first draft

Three questions came out of building this diagram (not the prose review); all three are now resolved in `schema.sql`:

1. **Onboarding order.** `utilities.default_account_id`, `income_sources.credit_to_account_id`, `tax_fees.debit_from_account_id`, and `goal_account_links.account_id` are all `NOT NULL`, on purpose — at least one Account must exist before anything else can be created, consistent with Account already being the foundation everything else in the spec builds on (2.1). Setup flow: Settings → at least one Account → everything else.
2. **Day-of-month clamping.** `due_date_day` / `cut_off_date_day` are a recurring day-of-month (1–31), and when that day doesn't exist in the target month (day 31 in a 30-day month, day 29–31 in February), it clamps to that month's last day — the standard billing-cycle convention. Same rule applies when `recurring_rules.next_run_date` advances across a Monthly/Bi-Monthly boundary. Reference query in `schema.sql`.
3. **Money-pit flag dedup.** At most one `Active` flag per category (`CategoryTrend`) or recurring-charge pattern (`RecurringChargeCluster`, keyed by a new `cluster_key` column), enforced by two partial unique indexes. Re-detecting an already-`Active` pattern updates that row rather than duplicating it; a pattern the user dismissed gets a *new* row if it resurfaces later — dismissal is a user-owned terminal state that re-detection never silently overturns, mirroring how Goal Status (2.8) never overrides a user's `Abandoned` choice.
