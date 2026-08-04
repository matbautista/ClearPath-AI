-- ClearPath AI — Database Schema (SQLite)
-- Derived from ClearPath-AI-Spec-Baseline.md (v9, closed baseline).
--
-- ENGINE CHOICE: SQLite, because the spec's own opening line calls for
-- "a self-hosted, lightweight database." If a different engine/ORM is
-- actually intended, this DDL translates with minor syntax changes —
-- the design (tables, keys, the money/derived-state conventions below)
-- carries over regardless of engine.
--
-- MONEY CONVENTION: every monetary column is an INTEGER in minor units
-- (cents/centavos), never REAL/FLOAT/NUMERIC — the spec is explicit
-- that money must be fixed-point, never floating point (2.2), and
-- SQLite's dynamic typing means only INTEGER guarantees that.
--
-- DERIVED-STATE CONVENTION: `current_balance_minor` / `card_balance_minor`
-- on accounts, and `status` on goals, are CACHED columns maintained by
-- application logic alongside each transaction insert/void — the
-- transactions table (and, for goals, the accounts it references)
-- remains the actual source of truth. See the recomputation queries
-- at the bottom of this file, which must agree with the cached values
-- at all times; use them as a consistency check / migration tool.
-- (This is the spec's own "derived, not cached" rule — 2.1's
-- Available Balance, 2.8's Goal Status — applied consistently.)
--
-- GAPS FOUND WHILE TRANSLATING PROSE -> SCHEMA (not caught by any of
-- the 9 prose review rounds, because they're completeness gaps, not
-- contradictions between two stated rules):
--   1. Utility (3.7) never had a default source account, unlike Income
--      Source's "Credit To" and Tax/Fee's "Debit From" — but the
--      auto-draft job (2.7) needs SOME account to post a Utility's
--      Pending Confirmation transaction against before the user
--      reviews it. Added `utilities.default_account_id`.
--   2. Utility/Income Source/Tax/Fee (3.7/3.8/3.9) were never
--      formalized as tables — only Account/Transaction/Settings/
--      Recurring Rule/Goal were. Formalized here as `utilities`,
--      `income_sources`, `tax_fees`.
--   3. Net Worth Snapshot (3.1 — "stores it as a lightweight
--      time-series record") and Money-Pit Flag (3.1/3.11a —
--      "dismissible list") were both described in prose as requiring
--      persistence, but neither was ever given a field table.
--      Formalized here as `net_worth_snapshots`, `money_pit_flags`.
--   4. Due Date / Cut-off Date (2.1) are billing-cycle concepts that
--      recur every period, not one-time calendar dates — modeled as
--      day-of-month integers (1-31), not DATE columns. RESOLVED: when
--      a day-of-month exceeds the number of days in the target month
--      (e.g. day 31 in a 30-day month, or day 29-31 in February),
--      clamp to that month's last day — the standard billing-cycle
--      convention. See the "day-of-month clamping" reference query
--      near the bottom of this file; the same rule applies when
--      `recurring_rules.next_run_date` advances across a Monthly/
--      Bi-Monthly cycle boundary.
--   5. `ai_analysis_runs` is a genuinely new addition (not implied by
--      the spec beyond "last call date, call count" in Settings) —
--      added so a user can review past AI Analysis output rather than
--      it being ephemeral. Drop this table if that's not wanted;
--      nothing else depends on it.
--   6. `money_pit_flags` re-detection dedup: RESOLVED — at most one
--      Active flag per (CategoryTrend, spending_category_id) or
--      (RecurringChargeCluster, cluster_key) pair, enforced by partial
--      unique indexes below. Re-detecting an already-Active pattern
--      updates that row (metric_summary, detected_at) instead of
--      creating a duplicate. A pattern the user Dismissed gets a NEW
--      flag row if it's detected again later — dismissal is a
--      user-owned terminal state that re-detection must never silently
--      overturn, the same way Goal Status (2.8) never overrides a
--      user's Abandoned choice.
--
-- ONBOARDING ORDER: `utilities.default_account_id`,
-- `income_sources.credit_to_account_id`, `tax_fees.debit_from_account_id`,
-- and `goal_account_links.account_id` are all NOT NULL / required FKs to
-- `accounts` — RESOLVED: this is intentional, not an oversight. At least
-- one Account must exist before a Utility/Income Source/Tax record or a
-- Goal can be created, consistent with how the rest of the app already
-- depends on Account (2.1 is the unified foundation everything else
-- builds on). The setup flow should sequence: Settings -> at least one
-- Account -> everything else.
--
-- Section references in comments (e.g. "2.1", "3.10") point back to
-- ClearPath-AI-Spec-Baseline.md.

PRAGMA foreign_keys = ON;

-- =========================================================================
-- 2.0 Settings — single row (id is always 1)
-- =========================================================================
CREATE TABLE settings (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    base_currency               TEXT NOT NULL,                 -- ISO 4217, e.g. 'PHP' (4.2)
    auth_passphrase_hash        TEXT NOT NULL,                 -- (4.3)
    ai_analysis_enabled         INTEGER NOT NULL DEFAULT 0,    -- boolean; off by default (3.11)
    ai_api_key_encrypted        BLOB,                          -- (3.11)
    ai_provider                 TEXT,                          -- (3.11)
    ai_scheduled_auto_run       INTEGER NOT NULL DEFAULT 0,    -- boolean; opt-in full auto-run (3.11)
    ai_last_call_at             TEXT,                          -- ISO 8601 datetime (3.11 cost visibility)
    ai_call_count               INTEGER NOT NULL DEFAULT 0,    -- (3.11 cost visibility)
    notification_email          TEXT,                          -- (4.5)
    smtp_host                   TEXT,                          -- (4.5)
    smtp_port                   INTEGER,                       -- (4.5)
    smtp_username                TEXT,                          -- (4.5)
    smtp_password_encrypted     BLOB,                          -- (4.5)
    default_reminder_lead_time_days INTEGER NOT NULL DEFAULT 3, -- (2.0)
    created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =========================================================================
-- 2.1 Unified Account Model
-- =========================================================================
CREATE TABLE accounts (
    id                       INTEGER PRIMARY KEY,
    account_type             TEXT NOT NULL CHECK (account_type IN ('Cash','Bank','EWallet','Investment','Loan','CreditCard','RealEstate')),
    institution_name         TEXT,                          -- blank for Cash
    description              TEXT,
    account_number_encrypted BLOB,
    account_name             TEXT NOT NULL,
    beginning_balance_minor  INTEGER NOT NULL DEFAULT 0,     -- pre-existing accounts only; 0 for post-go-live (2.1)

    -- Cash/Bank/Investment/Loan: cached balance, derived from transactions.
    -- CreditCard: NOT used — see card_balance_minor instead (2.1/2.4b).
    current_balance_minor    INTEGER NOT NULL DEFAULT 0,

    -- CreditCard only: cached amount owed, derived from transactions.
    -- Available Balance is intentionally NOT a column — it is always
    -- (credit_limit_minor - card_balance_minor), computed on read (2.1/2.4b).
    card_balance_minor       INTEGER NOT NULL DEFAULT 0,

    interest_rate_pct        REAL,                           -- Loan/CreditCard only, annual % (2.1)
    valuation_method         TEXT CHECK (valuation_method IN ('CostBasis','MarketValue')), -- Investment only; fixed 'CostBasis' for v1 (2.4a)
    minimum_payment_minor    INTEGER,                        -- Loan/CreditCard only (2.1)
    credit_limit_minor       INTEGER,                        -- CreditCard only (2.1)
    loan_amount_minor        INTEGER,                        -- Loan only (2.1)
    loan_term_months         INTEGER,                        -- Loan only (2.1) — assumption: term is in months
    due_date_day             INTEGER CHECK (due_date_day BETWEEN 1 AND 31),      -- CreditCard/Loan only here (Utility's lives on utilities table) (2.1)
    cut_off_date_day         INTEGER CHECK (cut_off_date_day BETWEEN 1 AND 31),  -- CreditCard only (2.1 — Loans have no cutoff)
    reminder_lead_time_days  INTEGER,                        -- Loan/CreditCard override of settings.default_reminder_lead_time_days (2.1)
    status                   TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Closed')), -- (2.1)
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now')),

    -- Type-appropriate field guardrails (2.1's "X only" notes), enforced at
    -- the schema level for the fields most load-bearing to correctness.
    CHECK (
        (account_type = 'CreditCard' AND credit_limit_minor IS NOT NULL)
        OR (account_type != 'CreditCard' AND credit_limit_minor IS NULL AND cut_off_date_day IS NULL)
    ),
    CHECK (
        (account_type = 'Loan' AND loan_amount_minor IS NOT NULL)
        OR (account_type != 'Loan')
    ),
    CHECK (
        account_type IN ('Loan','CreditCard') OR (interest_rate_pct IS NULL AND minimum_payment_minor IS NULL AND reminder_lead_time_days IS NULL AND due_date_day IS NULL)
    ),
    CHECK (
        account_type = 'Investment' OR valuation_method IS NULL
    )
);

CREATE INDEX idx_accounts_type_status ON accounts(account_type, status);

-- =========================================================================
-- 2.4 Spending Categories — a real table (not a fixed enum) because
-- 4.6 requires rename/merge/delete lifecycle management.
-- =========================================================================
CREATE TABLE spending_categories (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    is_system   INTEGER NOT NULL DEFAULT 0, -- 1 for the v1 default set (2.4); still renameable/mergeable, but not delete-seeded twice on reinstall
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the default set (2.4). 'Internal Transfer' and 'Savings/Investment
-- Transfer' are the two categories excluded from Category Trend Detection
-- and Savings Rate (2.4/3.1/3.11a) — see the money_pit / savings-rate
-- queries at the bottom of this file for exactly how that exclusion is applied.
INSERT INTO spending_categories (name, is_system) VALUES
    ('Groceries', 1), ('Rent/Housing', 1), ('Transportation', 1), ('Utilities', 1),
    ('Dining', 1), ('Entertainment', 1), ('Healthcare', 1), ('Insurance', 1),
    ('Debt Payment', 1), ('Savings/Investment Transfer', 1), ('Internal Transfer', 1),
    ('Taxes/Fees', 1), ('Other', 1);

-- =========================================================================
-- 2.2 Transactions — two independent rows per two-leg event, linked via
-- linked_transaction_id (see 2.2's "two-leg transactions are two rows").
-- =========================================================================
CREATE TABLE transactions (
    id                      INTEGER PRIMARY KEY,
    description             TEXT,
    txn_date                TEXT NOT NULL,                  -- ISO 8601 date
    amount_minor            INTEGER NOT NULL CHECK (amount_minor >= 0),
    additional_fees_minor   INTEGER NOT NULL DEFAULT 0 CHECK (additional_fees_minor >= 0),
    -- total_amount_minor is NOT a stored column — it is always
    -- (amount_minor + additional_fees_minor), computed on read (2.2).

    indicator               TEXT NOT NULL CHECK (indicator IN ('Debit','Credit')), -- direction rule: see 2.2
    source_account_id       INTEGER NOT NULL REFERENCES accounts(id), -- the ONE account this row affects (2.2)
    destination_account_id  INTEGER REFERENCES accounts(id),          -- mirrors paired row's source; NULL for single-leg (2.2)

    txn_type                TEXT NOT NULL CHECK (txn_type IN (
                                 'BillsPayment','CashPayment','CashDeposit','CheckDeposit','CashWithdrawal',
                                 'eCashTransfer','eCashPayment','CardPurchase','CardPayment',
                                 'LoanDisbursement','LoanPayment','InvestmentBuy','InvestmentSell',
                                 'DividendInterestReceived','IncomeReceived'
                             )),                                        -- (2.3)

    spending_category_id    INTEGER REFERENCES spending_categories(id), -- Debit single-leg + both legs of two-leg txns; NULL for Loan Disbursement (2.2)
    income_category         TEXT CHECK (income_category IN (
                                 'Salaries','Bonuses','Consulting Fees','Dividends','Interests',
                                 'Capital Gains','Allowances','Tax Credits'
                             )),                                        -- single-leg external inflows only (2.2) — fixed enum, not user-editable (3.8), unlike spending_categories

    principal_portion_minor INTEGER,                       -- Loan/Card Payment only (2.2)
    interest_portion_minor  INTEGER,                       -- Loan/Card Payment only (2.2)

    linked_transaction_id   INTEGER REFERENCES transactions(id), -- paired row for two-leg txns (2.2/2.5/2.6)
    status                  TEXT NOT NULL DEFAULT 'Posted' CHECK (status IN ('Posted','Voided','PendingConfirmation')), -- (2.2/2.7)

    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now')),

    -- A row carries exactly one of spending_category_id / income_category,
    -- or neither (Loan Disbursement) — never both (2.2).
    CHECK (NOT (spending_category_id IS NOT NULL AND income_category IS NOT NULL)),
    -- Income Category only ever applies to a Credit-indicator row.
    CHECK (income_category IS NULL OR indicator = 'Credit'),
    -- Principal/Interest Portion only on Loan/Card Payment rows.
    CHECK ((principal_portion_minor IS NULL AND interest_portion_minor IS NULL) OR txn_type IN ('LoanPayment','CardPayment'))
);

CREATE INDEX idx_transactions_source_account_date ON transactions(source_account_id, txn_date);
CREATE INDEX idx_transactions_linked ON transactions(linked_transaction_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_category_date ON transactions(spending_category_id, txn_date);

-- =========================================================================
-- 3.7 / 3.8 / 3.9 — Utility, Income Source, Tax/Fee (never formalized as
-- tables in the prose spec; each gets its own Recurring Rule, 2.7).
--
-- Onboarding order: each of these requires an existing Account row
-- (default_account_id / credit_to_account_id / debit_from_account_id
-- below are NOT NULL) — see "ONBOARDING ORDER" in the header comment.
-- =========================================================================
CREATE TABLE utilities (
    id                       INTEGER PRIMARY KEY,
    provider_name            TEXT NOT NULL,
    description               TEXT,
    service_account_number   TEXT,
    service_account_name     TEXT,
    default_account_id       INTEGER NOT NULL REFERENCES accounts(id), -- GAP FIX #1 above: needed so auto-drafts (2.7) know a source account
    cut_off_date_day         INTEGER CHECK (cut_off_date_day BETWEEN 1 AND 31),
    due_date_day             INTEGER CHECK (due_date_day BETWEEN 1 AND 31),
    policy_type              TEXT,                          -- freeform, e.g. 'Life', 'Health', 'Auto' — only meaningful for insurance-type Utilities; NULL for electricity/water/etc.
    status                   TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')), -- Paused = cancelled/on-hold subscription: no auto-drafts, doesn't show in Upcoming Dues, history kept
    created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE income_sources (
    id                     INTEGER PRIMARY KEY,
    source_name            TEXT NOT NULL,
    description             TEXT,
    income_category        TEXT NOT NULL CHECK (income_category IN (
                                'Salaries','Bonuses','Consulting Fees','Dividends','Interests',
                                'Capital Gains','Allowances','Tax Credits'
                            )),
    credit_to_account_id   INTEGER NOT NULL REFERENCES accounts(id), -- (3.8 "Credit To")
    status                 TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')), -- Paused = source stopped (e.g. contract ended): no auto-drafts, doesn't show in Upcoming Dues, history kept
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tax_fees (
    id                     INTEGER PRIMARY KEY,
    regulatory_name        TEXT NOT NULL,
    description             TEXT,
    fee_category            TEXT,
    debit_from_account_id  INTEGER NOT NULL REFERENCES accounts(id), -- (3.9 "Debit From")
    status                 TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused')), -- Paused = no longer owed: no auto-drafts, doesn't show in Upcoming Dues, history kept
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =========================================================================
-- 2.7 Recurring Rule — polymorphic "Applies To" via three nullable FKs,
-- exactly one populated (standard SQLite pattern for this; no native
-- polymorphic FK type).
-- =========================================================================
CREATE TABLE recurring_rules (
    id                          INTEGER PRIMARY KEY,
    utility_id                  INTEGER REFERENCES utilities(id),
    income_source_id            INTEGER REFERENCES income_sources(id),
    tax_fee_id                  INTEGER REFERENCES tax_fees(id),
    schedule                    TEXT NOT NULL CHECK (schedule IN ('Annually','Quarterly','Monthly','Bi-Monthly','Variable')),
    template_amount_minor       INTEGER NOT NULL,
    next_run_date                TEXT,                          -- NULL for Variable (2.7 — doesn't auto-generate)
    last_generated_transaction_id INTEGER REFERENCES transactions(id),
    reminder_lead_time_days      INTEGER,                        -- override of settings default (2.7)
    created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),

    CHECK (
        (CASE WHEN utility_id IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN income_source_id IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN tax_fee_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    )
);

CREATE INDEX idx_recurring_rules_next_run ON recurring_rules(next_run_date) WHERE schedule != 'Variable';

-- =========================================================================
-- 2.8 Goal Model
-- =========================================================================
CREATE TABLE goals (
    id                          INTEGER PRIMARY KEY,
    goal_type                   TEXT NOT NULL CHECK (goal_type IN ('DebtPayoff','EmergencyFund','SavingsTarget','InvestmentTarget','MajorPurchase')),
    target_amount_minor         INTEGER NOT NULL,
    target_date                  TEXT,
    strategy                     TEXT CHECK (strategy IN ('Snowball','Avalanche')), -- DebtPayoff only (3.10); NULL otherwise
    total_monthly_payment_budget_minor INTEGER, -- DebtPayoff multi-debt only (3.10)

    -- Status is a CACHED, continuously-re-derived column (2.8 v9 fix) —
    -- 'Abandoned' is the only value the application sets directly; the
    -- rest is recomputed from linked account balances after every
    -- relevant transaction post/void. See recompute query at bottom.
    status                        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Completed','Abandoned')),

    created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),

    CHECK (goal_type = 'DebtPayoff' OR (strategy IS NULL AND total_monthly_payment_budget_minor IS NULL))
);

CREATE TABLE goal_account_links (
    id                    INTEGER PRIMARY KEY,
    goal_id               INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    account_id            INTEGER NOT NULL REFERENCES accounts(id),
    allocation_type       TEXT NOT NULL CHECK (allocation_type IN ('FixedAmount','Percentage')),
    allocation_value      REAL NOT NULL, -- minor-units integer if FixedAmount, 0-100 if Percentage; app layer distinguishes via allocation_type
    UNIQUE (goal_id, account_id)
);

CREATE INDEX idx_goal_account_links_account ON goal_account_links(account_id);

-- =========================================================================
-- 3.1 Net Worth Snapshot — daily time-series, not formalized in prose
-- (GAP FIX #3 above).
-- =========================================================================
CREATE TABLE net_worth_snapshots (
    id                    INTEGER PRIMARY KEY,
    snapshot_date          TEXT NOT NULL UNIQUE,
    total_assets_minor     INTEGER NOT NULL,
    total_liabilities_minor INTEGER NOT NULL,
    net_worth_minor        INTEGER NOT NULL, -- = total_assets_minor - total_liabilities_minor, stored (not recomputed) since this IS the time-series record itself
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =========================================================================
-- 3.1 / 3.11a Money-Pit Flags — dismissible, so must be persisted
-- (GAP FIX #3 above).
-- =========================================================================
CREATE TABLE money_pit_flags (
    id                     INTEGER PRIMARY KEY,
    flag_type              TEXT NOT NULL CHECK (flag_type IN ('CategoryTrend','RecurringChargeCluster')),
    spending_category_id   INTEGER REFERENCES spending_categories(id), -- CategoryTrend only — dedup key, see unique index below
    cluster_key            TEXT,                                       -- RecurringChargeCluster only — stable pattern identifier (e.g. normalized description), dedup key, see unique index below
    cluster_description    TEXT,                                       -- RecurringChargeCluster only — human-readable label (e.g. "AI subscription cluster")
    metric_summary         TEXT,                                       -- e.g. '{"growth_pct":40,"monthly_total_minor":450000}' — JSON text
    utilization_note       TEXT,                                       -- user's optional manual utilization note (3.11a)
    status                 TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Dismissed')),
    detected_at             TEXT NOT NULL DEFAULT (datetime('now')),
    dismissed_at            TEXT,

    CHECK (
        (flag_type = 'CategoryTrend' AND spending_category_id IS NOT NULL AND cluster_key IS NULL AND cluster_description IS NULL)
        OR (flag_type = 'RecurringChargeCluster' AND spending_category_id IS NULL AND cluster_key IS NOT NULL)
    )
);

-- Dedup on re-detection (GAP FIX #6 above): at most one Active flag per
-- category / cluster pattern. A re-run either UPDATEs the existing Active
-- row or, if none exists (including because the prior one was Dismissed),
-- INSERTs a new one — never creates a second concurrently-Active duplicate.
CREATE UNIQUE INDEX idx_money_pit_flags_category_active
    ON money_pit_flags(spending_category_id) WHERE flag_type = 'CategoryTrend' AND status = 'Active';
CREATE UNIQUE INDEX idx_money_pit_flags_cluster_active
    ON money_pit_flags(cluster_key) WHERE flag_type = 'RecurringChargeCluster' AND status = 'Active';

-- Member transactions of a RecurringChargeCluster flag (many-to-many).
CREATE TABLE money_pit_flag_transactions (
    flag_id         INTEGER NOT NULL REFERENCES money_pit_flags(id) ON DELETE CASCADE,
    transaction_id  INTEGER NOT NULL REFERENCES transactions(id),
    PRIMARY KEY (flag_id, transaction_id)
);

-- =========================================================================
-- 3.11 AI Analysis run history (GAP FIX #5 above — new, optional; drop
-- this table if you don't want past analyses retained).
-- =========================================================================
CREATE TABLE ai_analysis_runs (
    id              INTEGER PRIMARY KEY,
    ran_at           TEXT NOT NULL DEFAULT (datetime('now')),
    status          TEXT NOT NULL CHECK (status IN ('Success','Failed')),
    output_text     TEXT,      -- the written summary + plan (3.11 Outputs); NULL if Failed
    error_message   TEXT       -- NULL if Success
);

-- =========================================================================
-- Reference queries: derived-state recomputation (verification / migration)
-- =========================================================================

-- Recompute an account's cached current_balance_minor / card_balance_minor
-- from transaction history — should always match the cached column (2.1's
-- "derived, not cached" rule). Debit reduces the row's own account per the
-- direction convention in 2.2; Credit increases it. Only Posted rows count.
--
-- SELECT source_account_id,
--        SUM(CASE WHEN indicator = 'Credit' THEN amount_minor ELSE -amount_minor END) AS recomputed_delta
-- FROM transactions
-- WHERE status = 'Posted'
-- GROUP BY source_account_id;
-- (Add accounts.beginning_balance_minor to get the full recomputed balance.)

-- Recompute a Goal's Status per 2.8's balance-based completion trigger —
-- run after every transaction post/void affecting a linked account.
--
-- DebtPayoff: Completed if every linked Loan/CreditCard account's
-- current_balance_minor/card_balance_minor = 0; else Active.
-- EmergencyFund/SavingsTarget/InvestmentTarget/MajorPurchase: Completed if
-- SUM(linked accounts' allocation-adjusted balance) >= target_amount_minor;
-- else Active. Never touches Abandoned goals.

-- Day-of-month clamping (GAP FIX #4 above): given a target year-month and
-- a stored day-of-month (accounts.due_date_day/cut_off_date_day,
-- utilities.due_date_day/cut_off_date_day), the actual date is the
-- smaller of that day and the target month's last day. Also applies when
-- recurring_rules.next_run_date advances across a Monthly/Bi-Monthly
-- boundary (e.g. Jan 31 -> Feb 28/29, never Feb 31).
--
-- SELECT MIN(:day_of_month, CAST(strftime('%d', date(:year || '-' || :month || '-01', '+1 month', '-1 day')) AS INTEGER))
--        AS clamped_day_of_month;

-- Category totals (Category Trend Detection 3.11a / Savings Rate 3.1):
-- count a linked pair once, off the Debit leg only, per 2.2's rule —
-- e.g. for Debt Payment, only the Debit leg's interest_portion_minor:
--
-- SELECT spending_category_id, SUM(
--          CASE WHEN txn_type IN ('LoanPayment','CardPayment')
--               THEN interest_portion_minor ELSE amount_minor END
--        ) AS category_total_minor
-- FROM transactions
-- WHERE status = 'Posted' AND indicator = 'Debit'
--   AND spending_category_id NOT IN (
--       SELECT id FROM spending_categories WHERE name IN ('Internal Transfer','Savings/Investment Transfer')
--   )
-- GROUP BY spending_category_id;
