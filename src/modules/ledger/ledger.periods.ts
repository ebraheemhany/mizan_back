import type { Prisma } from "../../generated/prisma/client.js";
import { addMonths, businessToday, monthRange, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { entryHeaders } from "./ledger.sql.js";

type Tx = Prisma.TransactionClient;

/**
 * Closing the books: everything dated on or before the company's closing date is
 * final. Nothing may be added, changed or removed there: no manual entry, and no
 * invoice issued, cancelled or paid, no payment removed and no expense added or
 * deleted with such a date. Only months that have ended can be closed, so today
 * is always open.
 */
export const periodClosed = (closedThrough: string) =>
  new AppError(
    409,
    "PERIOD_CLOSED",
    `The books are closed through ${closedThrough}; this date is in a closed period`,
    { closedThrough },
  );

/** Refuses any of `dates` on or before the closing date. */
export function checkBooksOpen(closedThrough: Date | null, dates: readonly (string | null | undefined)[]) {
  if (!closedThrough) return;
  const limit = toIso(closedThrough);
  if (dates.some((d) => d && d <= limit)) throw periodClosed(limit);
}

/**
 * The same check inside a transaction that doesn't otherwise lock the company:
 * the shared row lock keeps the books from being closed until this transaction
 * ends, so a change can't slip into a month being closed at that moment.
 * Call it first in the transaction (it takes the company lock before any row
 * the transaction changes, the same order as everywhere else, so no deadlock).
 * Transactions that update the company row anyway (taking a number) read the
 * closing date from that update and use checkBooksOpen instead.
 */
export async function assertBooksOpen(tx: Tx, companyId: string, dates: readonly (string | null | undefined)[]) {
  checkBooksOpen(await lockBooks(tx, companyId), dates);
}

/** The closing date, with the company row locked (shared) until the transaction ends. */
export async function lockBooks(tx: Tx, companyId: string) {
  const [row] = await tx.$queryRaw<{ closedThrough: Date | null }[]>`
    SELECT "booksClosedThrough" AS "closedThrough" FROM "companies" WHERE "id" = ${companyId} FOR SHARE`;
  return row?.closedThrough ?? null;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

const monthOf = (iso: string) => iso.slice(0, 7);
const nextMonth = (month: string) => monthOf(addMonths(`${month}-01`, 1));

/** The fiscal year containing `today`, from the month it starts in (Settings). */
export function fiscalYear(today: string, startMonth: number) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  return { start, end: monthRange(start, 11).end };
}

/**
 * The closing state: the last closed month, the open months (from the one after
 * it, or from the first month with anything in the books, up to this month) with
 * their draft entries, and the month that can be closed next (last month, if open).
 */
export async function getPeriods(companyId: string) {
  const today = businessToday();
  const currentMonth = monthOf(today);
  const [company, [first], drafts] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { booksClosedThrough: true, booksClosedAt: true, fiscalStartMonth: true },
    }),
    prisma.$queryRaw<{ first: Date | null }[]>`SELECT MIN(h."date") AS "first" FROM (${entryHeaders(companyId)}) h`,
    prisma.$queryRaw<{ month: string; count: number }[]>`
      SELECT to_char("date", 'YYYY-MM') AS "month", COUNT(*)::int AS "count"
      FROM "journal_entries"
      WHERE "companyId" = ${companyId} AND "status" = 'draft'
      GROUP BY 1`,
  ]);
  const closedThrough = company.booksClosedThrough ? toIso(company.booksClosedThrough) : null;
  const firstMonth = first?.first ? monthOf(toIso(first.first)) : currentMonth;
  let month = closedThrough ? nextMonth(monthOf(closedThrough)) : firstMonth < currentMonth ? firstMonth : currentMonth;

  const draftsIn = new Map(drafts.map((d) => [d.month, d.count]));
  const open: { month: string; ended: boolean; drafts: number }[] = [];
  for (; month <= currentMonth; month = nextMonth(month)) {
    open.push({ month, ended: month < currentMonth, drafts: draftsIn.get(month) ?? 0 });
  }
  const lastMonth = monthOf(monthRange(today, -1).start);
  const toClose = open.some((m) => m.month === lastMonth) ? lastMonth : null;
  // Cheques still waiting to clear, dated in what closing would close: if one
  // bounces later, removing it means opening the month again.
  const pendingCheques = toClose
    ? await prisma.invoicePayment.count({
        where: {
          companyId,
          method: "cheque",
          status: "pending",
          date: { lte: toDate(monthRange(`${toClose}-01`).end) },
        },
      })
    : 0;

  return {
    today,
    closedThrough,
    closedAt: company.booksClosedAt?.toISOString() ?? null,
    // Newest first.
    open: open.reverse(),
    toClose,
    pendingCheques,
    fiscalYear: fiscalYear(today, company.fiscalStartMonth),
  };
}

/**
 * Closes the books through the end of `month` (and every open month before it).
 * The month must have ended, and no draft entry may be dated in what closes.
 */
export async function closePeriod(companyId: string, month: string) {
  const currentMonth = monthOf(businessToday());
  if (month >= currentMonth) {
    throw new AppError(409, "PERIOD_NOT_ENDED", "Only a month that has ended can be closed", { field: "month" });
  }
  const through = monthRange(`${month}-01`).end;

  await prisma.$transaction(async (tx) => {
    // The update locks the company row first: no entry can be added in this
    // month until the transaction ends, so the drafts count below is final.
    const { count } = await tx.company.updateMany({
      where: {
        id: companyId,
        OR: [{ booksClosedThrough: null }, { booksClosedThrough: { lt: toDate(through) } }],
      },
      data: { booksClosedThrough: toDate(through), booksClosedAt: new Date() },
    });
    if (count === 0) throw new AppError(409, "PERIOD_ALREADY_CLOSED", "This month is already closed");

    const drafts = await tx.journalEntry.count({
      where: { companyId, status: "draft", date: { lte: toDate(through) } },
    });
    if (drafts > 0) {
      throw new AppError(409, "PERIOD_HAS_DRAFTS", "Post or delete the draft entries in this period first", { drafts });
    }
  });
  return getPeriods(companyId);
}

/** Opens the last closed month again (owner only): the books stay closed through the month before it. */
export async function reopenPeriod(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { booksClosedThrough: true },
  });
  if (!company.booksClosedThrough) throw new AppError(409, "PERIOD_NOT_CLOSED", "No month is closed");
  const current = toIso(company.booksClosedThrough);
  const through = monthRange(current, -1).end;

  // Only from the state that was read (a close or reopen meanwhile wins).
  const { count } = await prisma.company.updateMany({
    where: { id: companyId, booksClosedThrough: toDate(current) },
    data: { booksClosedThrough: toDate(through), booksClosedAt: null },
  });
  if (count === 0) throw new AppError(409, "PERIOD_CHANGED", "The closed period changed meanwhile; reload and try again");
  return getPeriods(companyId);
}
