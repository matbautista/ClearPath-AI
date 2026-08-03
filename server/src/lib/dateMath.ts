// Calendar-date arithmetic on plain "YYYY-MM-DD" strings, deliberately
// avoiding `new Date(dateStr)` (which parses a date-only string as LOCAL
// midnight) mixed with `.toISOString()` (which renders in UTC) — that
// combination silently shifts the date by a day whenever the server's
// timezone isn't UTC+0. Every date in this app (transaction dates, due
// dates, snapshot dates) is a timezone-naive calendar date, matching what
// an HTML <input type="date"> produces — so all arithmetic here uses
// Date.UTC() consistently, never local-time parsing, to stay safe
// regardless of server timezone.
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysUTC(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
