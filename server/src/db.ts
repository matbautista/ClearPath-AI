// Uses Node's built-in `node:sqlite` (no native compilation required) rather
// than better-sqlite3 — this dev machine has no working Python/node-gyp
// toolchain for native modules. node:sqlite is experimental as of Node 22-24
// but has an API compatible enough with better-sqlite3 for our purposes
// (prepare/run/get/all, named @param binding, lastInsertRowid). Revisit if
// the target deployment environment has a working native-module toolchain
// and you'd rather have the more battle-tested better-sqlite3.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// server/ and schema/ are siblings under the project root.
const PROJECT_ROOT = join(__dirname, "..", "..");
const DB_PATH = process.env.CLEARPATH_DB_PATH ?? join(PROJECT_ROOT, "data", "clearpath.db");
const SCHEMA_PATH = join(PROJECT_ROOT, "schema", "schema.sql");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

function bootstrapSchema() {
  const hasAccounts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
    .get();
  if (!hasAccounts) {
    const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
    db.exec(schemaSql);
    console.log(`[db] bootstrapped schema from ${SCHEMA_PATH} into ${DB_PATH}`);
  }
}

// SQLite can't ALTER a CHECK constraint in place — adding 'EWallet' to
// accounts.account_type needs the standard SQLite recreate-table dance.
//
// IMPORTANT: never `ALTER TABLE accounts RENAME TO accounts_old` here.
// SQLite auto-rewrites every OTHER table's FOREIGN KEY clause that names
// a renamed table (so it keeps pointing at the same object under its new
// name) — but a plain DROP TABLE does NOT do any such rewrite. So
// rename-old -> create-new -> drop-old permanently corrupts every table
// with `REFERENCES accounts(id)` (transactions, utilities, income_sources,
// tax_fees, goal_account_links all got rewritten to reference a table
// that no longer existed the moment the old one was dropped — this was
// live-debugged the hard way; see repairAccountsOldReferences below for
// the one-time fix for a DB that already hit this).
//
// The safe order instead: build the replacement under a throwaway name
// first (nothing references that name, so the final rename touches
// nothing else), copy data in, THEN drop the original and rename the
// replacement into its place.
function migrateAccountsAddEWallet() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'EWallet'")) return;

  console.log("[db] migration: adding 'EWallet' to accounts.account_type");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE accounts_new (
          id                       INTEGER PRIMARY KEY,
          account_type             TEXT NOT NULL CHECK (account_type IN ('Cash','Bank','EWallet','Investment','Loan','CreditCard')),
          institution_name         TEXT,
          description              TEXT,
          account_number_encrypted BLOB,
          account_name             TEXT NOT NULL,
          beginning_balance_minor  INTEGER NOT NULL DEFAULT 0,
          current_balance_minor    INTEGER NOT NULL DEFAULT 0,
          card_balance_minor       INTEGER NOT NULL DEFAULT 0,
          interest_rate_pct        REAL,
          valuation_method         TEXT CHECK (valuation_method IN ('CostBasis','MarketValue')),
          minimum_payment_minor    INTEGER,
          credit_limit_minor       INTEGER,
          loan_amount_minor        INTEGER,
          loan_term_months         INTEGER,
          due_date_day             INTEGER CHECK (due_date_day BETWEEN 1 AND 31),
          cut_off_date_day         INTEGER CHECK (cut_off_date_day BETWEEN 1 AND 31),
          reminder_lead_time_days  INTEGER,
          status                   TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Closed')),
          created_at                TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
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
      )
    `);
    db.exec("INSERT INTO accounts_new SELECT * FROM accounts");
    db.exec("DROP TABLE accounts");
    db.exec("ALTER TABLE accounts_new RENAME TO accounts");
    db.exec("CREATE INDEX idx_accounts_type_status ON accounts(account_type, status)");
    db.exec("COMMIT");
    console.log("[db] migration: accounts table rebuilt with EWallet support");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// One-time repair for a DB that already hit the rename-then-drop bug
// described above: any table whose stored schema still says
// `REFERENCES "accounts_old"(id)` gets rebuilt with that fixed back to
// `accounts`, preserving every other byte of its schema and all of its
// data. Safe against the same cascade because it never renames the
// broken original away — it builds the fix under a throwaway name,
// copies data, then drops the broken original and renames the fix into
// its place (nothing ever pointed at the throwaway name, so that final
// rename has nothing else to cascade into).
function repairAccountsOldReferences() {
  const broken = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%accounts_old%'`).all() as {
    name: string;
    sql: string;
  }[];
  if (broken.length === 0) return;

  console.log(`[db] migration: repairing ${broken.length} table(s) with a stale accounts_old reference`);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    for (const { name, sql } of broken) {
      const tempName = `${name}_fixing`;
      const fixedSql = sql
        .replace(`CREATE TABLE ${name} (`, `CREATE TABLE ${tempName} (`)
        .replaceAll('"accounts_old"', '"accounts"')
        .replaceAll("accounts_old", "accounts");
      db.exec(fixedSql);
      db.exec(`INSERT INTO ${tempName} SELECT * FROM ${name}`);
      db.exec(`DROP TABLE ${name}`);
      db.exec(`ALTER TABLE ${tempName} RENAME TO ${name}`);
      console.log(`[db] migration: repaired ${name}`);
    }
    // The DROP TABLE calls above also dropped each table's own indexes —
    // rebuild the ones schema.sql defines for the affected tables.
    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_source_account_date ON transactions(source_account_id, txn_date)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_linked ON transactions(linked_transaction_id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_category_date ON transactions(spending_category_id, txn_date)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_goal_account_links_account ON goal_account_links(account_id)");
    db.exec("COMMIT");
    console.log("[db] migration: accounts_old repair complete");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// Lightweight additive migrations for existing databases — bootstrapSchema
// only runs schema.sql once (on a brand-new DB), so a column added to
// schema.sql later needs an explicit, idempotent ALTER TABLE here or an
// existing install never gets it. Only ever ADD nullable columns this way;
// anything more invasive needs a real migration.
function runMigrations() {
  const utilityColumns = db.prepare("PRAGMA table_info(utilities)").all() as { name: string }[];
  if (!utilityColumns.some((c) => c.name === "policy_type")) {
    db.exec("ALTER TABLE utilities ADD COLUMN policy_type TEXT");
    console.log("[db] migration: added utilities.policy_type");
  }

  migrateAccountsAddEWallet();
  repairAccountsOldReferences();
}

bootstrapSchema();
runMigrations();
