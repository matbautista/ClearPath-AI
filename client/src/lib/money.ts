// All amounts cross the API as INTEGER minor units (2.2 — fixed-point,
// never floating point). No base currency is configured yet (Settings/
// setup flow isn't built), so this formats a plain decimal amount without
// a currency symbol until that's wired up.
export function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  return `${sign}${major.toLocaleString()}.${minor}`;
}

export function toMinorUnits(majorAmount: number): number {
  return Math.round(majorAmount * 100);
}
