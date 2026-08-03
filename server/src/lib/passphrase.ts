// Passphrase hashing via Node's built-in crypto.scrypt — deliberately not
// bcrypt/argon2, both native modules, to avoid the same node-gyp/Python
// build-toolchain problem that ruled out better-sqlite3 (see db.ts).
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LEN = 64;

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, KEY_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(passphrase, salt, KEY_LEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
