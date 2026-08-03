// All amounts cross the API as INTEGER minor units (2.2 — fixed-point,
// never floating point).
export function formatMinor(amountMinor: number, currency?: string | null): string {
  const major = amountMinor / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(major);
    } catch {
      // fall through to plain formatting if the currency code isn't recognized
    }
  }
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const wholePart = Math.floor(abs / 100);
  const minorPart = String(abs % 100).padStart(2, "0");
  return `${sign}${wholePart.toLocaleString()}.${minorPart}`;
}

export function toMinorUnits(majorAmount: number): number {
  return Math.round(majorAmount * 100);
}
