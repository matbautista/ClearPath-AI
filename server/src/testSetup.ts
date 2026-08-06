// Runs once per test file, before that file's own imports are evaluated —
// gives every test file an isolated, throwaway SQLite database instead of
// sharing (or worse, colliding on) data/clearpath.db. db.ts reads
// CLEARPATH_DB_PATH at import time and bootstraps schema.sql into it
// automatically when the file doesn't exist yet, so nothing else is needed
// here.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLEARPATH_DB_PATH = join(tmpdir(), `clearpath-test-${randomUUID()}.db`);
