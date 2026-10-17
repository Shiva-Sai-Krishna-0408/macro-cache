/** Dates are plain calendar days as "YYYY-MM-DD" strings, interpreted in UTC for arithmetic. */
export type ISODate = string;

const DAY_MS = 86_400_000;

export function parseDate(d: ISODate): number {
  return Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
}

export function formatDate(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return formatDate(parseDate(d) + n * DAY_MS);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && formatDate(parseDate(s)) === s;
}

/** Today's date in an IANA time zone (falls back to UTC). */
export function todayIn(timeZone?: string | null, now: Date = new Date()): ISODate {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Monday of the week containing d. */
export function weekStart(d: ISODate): ISODate {
  const dow = new Date(parseDate(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}
