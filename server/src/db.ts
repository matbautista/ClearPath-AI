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

bootstrapSchema();
