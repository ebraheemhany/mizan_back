/**
 * Business dates (issue date, due date, payment date) are calendar days with no
 * time. They are stored as Postgres DATE and handled as "yyyy-mm-dd" strings or
 * as Date objects at UTC midnight.
 *
 * "Today" is the date in Egypt, so an invoice due today doesn't turn overdue at
 * 10pm because the server runs on UTC.
 */
export const BUSINESS_TIME_ZONE = "Africa/Cairo";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Egypt, "yyyy-mm-dd". */
export function businessToday(now = new Date()) {
  // en-CA formats as yyyy-mm-dd.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** True for a real calendar date written as yyyy-mm-dd (rejects 2026-02-30). */
export function isIsoDate(value: string) {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "yyyy-mm-dd" -> Date at UTC midnight (what Prisma expects for a DATE column). */
export const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Date from a DATE column -> "yyyy-mm-dd". */
export const toIso = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(iso: string, days: number) {
  return toIso(new Date(toDate(iso).getTime() + days * DAY_MS));
}

/**
 * `iso` plus whole months, keeping the day of the month; a day the target month
 * doesn't have becomes its last day (Jan 31 + 1 month = Feb 28 or 29).
 */
export function addMonths(iso: string, months: number) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return toIso(new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))));
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: string, to: string) {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS);
}

/** First and last day of the month containing `iso`, shifted by `offset` months. */
export function monthRange(iso: string, offset = 0) {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1 + offset, 1));
  const end = new Date(Date.UTC(y, m + offset, 0));
  return { start: toIso(start), end: toIso(end) };
}

/** First and last day of the calendar quarter containing `iso`, shifted by `offset` quarters. */
export function quarterRange(iso: string, offset = 0) {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  const firstMonth = (Math.floor((m - 1) / 3) + offset) * 3; // 0-based; Date.UTC wraps years
  const start = new Date(Date.UTC(y, firstMonth, 1));
  const end = new Date(Date.UTC(y, firstMonth + 3, 0));
  return { start: toIso(start), end: toIso(end) };
}

/** The calendar year containing `iso`, shifted by `offset` years. */
export function yearRange(iso: string, offset = 0) {
  const y = Number(iso.slice(0, 4)) + offset;
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}
