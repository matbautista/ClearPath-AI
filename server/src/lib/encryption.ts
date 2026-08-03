// Encryption-at-rest for Settings secrets (AI API key, SMTP password — 3.11/4.5).
// The DB file stores AES-256-GCM ciphertext; the key lives in a separate
// file outside the DB (data/master.key, gitignored, generated on first
// use). This protects the honest threat this app can realistically defend
// against for a self-hosted single-user deployment — the DB file alone
// leaking (a stray backup, an accidental commit) doesn't expose the key —
// not an attacker with full read access to the server, which no
// application-layer secret can prevent anyway.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const KEY_PATH = process.env.CLEARPATH_MASTER_KEY_PATH ?? join(PROJECT_ROOT, "data", "master.key");

let cachedKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  if (existsSync(KEY_PATH)) {
    cachedKey = readFileSync(KEY_PATH);
  } else {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_PATH, cachedKey, { mode: 0o600 });
  }
  return cachedKey;
}

// Packed as iv(12) + authTag(16) + ciphertext.
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
