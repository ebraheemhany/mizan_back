import { Prisma, type AccountType, type JournalStatus } from "../../generated/prisma/client.js";
import { monthRange, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { paymentNumber } from "../invoices/invoices.service.js";
import { debitNormal, getChart, idsByKey, type ChartAccount } from "./ledger.chart.js";
import { checkBooksOpen, lockBooks } from "./ledger.periods.js";
import type { AccountInput, EntryInput, ListEntriesQuery, UpdateAccountInput } from "./ledger.schemas.js";
import { autoLines, entryHeaders, type EntrySource } from "./ledger.sql.js";
import { audit } from "../audit/audit.service.js";

type Actor = { id: string; companyId: string };
type Tx = Prisma.TransactionClient;
type Side = { debit: Decimal; credit: Decimal };

export const entryNumber = (n: number) => `JE-${String(n).padStart(4, "0")}`;

const isPrismaError = (err: unknown, code: string) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;

// ---------------------------------------------------------------------------
// Totals per account
// ---------------------------------------------------------------------------

export type DateRange = { from?: string; to?: string };

function dateFilter(column: Prisma.Sql, range: DateRange) {
  const parts = [
    ...(range.from ? [Prisma.sql`AND ${column} >= ${toDate(range.from)}::date`] : []),
    ...(range.to ? [Prisma.sql`AND ${column} <= ${toDate(range.to)}::date`] : []),
  ];
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

/**
 * Debits and credits per account (by id) over a date range: the automatic
 * entries plus posted manual ones. Drafts never count.
 */
export async function accountTotals(companyId: string, chart: ChartAccount[], range: DateRange = {}) {
  const [auto, manual] = await Promise.all([
    prisma.$queryRaw<{ key: string; debit: Decimal; credit: Decimal }[]>`
      SELECT x."key", SUM(x."debit") AS "debit", SUM(x."credit") AS "credit"
      FROM (${autoLines(companyId)}) x
      WHERE TRUE ${dateFilter(Prisma.raw(`x."date"`), range)}
      GROUP BY x."key"`,
    prisma.$queryRaw<{ accountId: string; debit: Decimal; credit: Decimal }[]>`
      SELECT l."accountId", SUM(l."debit") AS "debit", SUM(l."credit") AS "credit"
      FROM "journal_lines" l
      JOIN "journal_entries" j ON j."id" = l."entryId"
      WHERE j."companyId" = ${companyId} AND j."status" = 'posted' ${dateFilter(Prisma.raw(`j."date"`), range)}
      GROUP BY l."accountId"`,
  ]);

  const totals = new Map<string, Side>();
  const add = (id: string, debit: Decimal, credit: Decimal) => {
    const t = totals.get(id) ?? { debit: ZERO, credit: ZERO };
    totals.set(id, { debit: t.debit.plus(new Decimal(debit)), credit: t.credit.plus(new Decimal(credit)) });
  };
  const byKey = idsByKey(chart);
  for (const row of auto) {
    const id = byKey.get(row.key);
    // getChart adds every built-in account, so this can't happen.
    if (!id) throw new Error(`The chart has no "${row.key}" account`);
    add(id, row.debit, row.credit);
  }
  for (const row of manual) add(row.accountId, row.debit, row.credit);
  return totals;
}

/** What the account holds, on its normal side (assets and expenses: debit - credit). */
export const balanceOf = (type: AccountType, t: Side | undefined) =>
  !t ? ZERO : debitNormal(type) ? t.debit.minus(t.credit) : t.credit.minus(t.debit);

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

const accountRef = (a: ChartAccount) => ({ id: a.id, code: a.code, key: a.key, name: a.name, type: a.type });

export async function listAccounts(companyId: string) {
  const chart = await getChart(companyId);
  const [totals, used] = await Promise.all([
    accountTotals(companyId, chart),
    prisma.journalLine.groupBy({ by: ["accountId"], where: { entry: { companyId } } }),
  ]);
  const usedIds = new Set(used.map((u) => u.accountId));
  return chart.map((a) => ({
    ...accountRef(a),
    system: a.key !== null,
    balance: moneyString(balanceOf(a.type, totals.get(a.id))),
    // Built-in accounts can't be removed; an added one only while no entry uses it.
    used: a.key !== null || usedIds.has(a.id),
  }));
}

const codeUsed = () =>
  new AppError(409, "ACCOUNT_CODE_USED", "Another account already has this code", { field: "code" });
const systemAccount = () => new AppError(409, "SYSTEM_ACCOUNT", "Built-in accounts can't be changed or removed");
const accountInUse = () => new AppError(409, "ACCOUNT_IN_USE", "This account is used in journal entries");

async function findCustomAccount(companyId: string, id: string) {
  const row = await prisma.ledgerAccount.findFirst({ where: { id, companyId }, select: { id: true, key: true } });
  if (!row) throw notFound("Account");
  if (row.key !== null) throw systemAccount();
  return row;
}

export async function createAccount(companyId: string, input: AccountInput) {
  await getChart(companyId);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.ledgerAccount.create({
        data: { ...input, companyId },
        select: { id: true, code: true, key: true, name: true, type: true },
      });
      await audit(tx, companyId, {
        action: "create",
        event: "accountCreated",
        item: { type: "ledgerAccount", id: created.id, ref: `${created.code} ${created.name}` },
        values: { type: created.type },
      });
      return created;
    });
    return { ...accountRef(row), system: false, balance: "0.00", used: false };
  } catch (err) {
    if (isPrismaError(err, "P2002")) throw codeUsed();
    throw err;
  }
}

export async function updateAccount(companyId: string, id: string, input: UpdateAccountInput) {
  await findCustomAccount(companyId, id);
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.ledgerAccount.findUniqueOrThrow({ where: { id }, select: { code: true, name: true } });
      await tx.ledgerAccount.updateMany({ where: { id, companyId, key: null }, data: input });
      await audit(tx, companyId, {
        action: "update",
        event: "accountUpdated",
        item: { type: "ledgerAccount", id, ref: `${input.code} ${input.name}` },
        values: { from: `${before.code} ${before.name}` },
      });
    });
  } catch (err) {
    if (isPrismaError(err, "P2002")) throw codeUsed();
    throw err;
  }
  const account = (await listAccounts(companyId)).find((a) => a.id === id);
  if (!account) throw notFound("Account");
  return account;
}

/**
 * Removes an added account no entry uses. Its lines would go with it (the foreign
 * key cascades, for deleting whole companies), so the check must be final: the
 * account row is locked first. An entry being saved with this account holds a
 * key-share lock on it until it commits, so either the count below sees its
 * lines, or that entry waits and then fails because the account is gone.
 */
export async function deleteAccount(companyId: string, id: string) {
  await findCustomAccount(companyId, id);
  await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; code: string; name: string | null }[]>`
      SELECT "id", "code", "name" FROM "ledger_accounts"
      WHERE "id" = ${id} AND "companyId" = ${companyId} AND "key" IS NULL
      FOR UPDATE`;
    if (!row) throw notFound("Account");
    if (await tx.journalLine.count({ where: { accountId: id } })) throw accountInUse();
    await tx.ledgerAccount.delete({ where: { id } });
    await audit(tx, companyId, {
      action: "delete",
      event: "accountDeleted",
      item: { type: "ledgerAccount", ref: `${row.code} ${row.name ?? ""}`.trim() },
    });
  });
}

/** An entry naming an account deleted meanwhile: the foreign key refuses its lines. */
async function savingLines<T>(save: () => Promise<T>) {
  try {
    return await save();
  } catch (err) {
    if (isPrismaError(err, "P2003")) {
      throw new AppError(400, "INVALID_ACCOUNT", "Choose accounts from this company's chart", { field: "lines" });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Journal: automatic and manual entries together
// ---------------------------------------------------------------------------

type HeaderRow = { source: EntrySource; entryId: string; date: Date; status: JournalStatus; amount: Decimal };
type LineDto = ReturnType<typeof accountRef> & { debit: string; credit: string };

const SOURCES: Record<Exclude<ListEntriesQuery["source"], "all">, EntrySource[]> = {
  invoice: ["invoice"],
  payment: ["payment", "chequeCleared", "chequeBounced"],
  expense: ["expense", "expensePayment"],
  manual: ["manual"],
};

/** `q` for ILIKE, with its own % and _ taken literally. */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listEntries(companyId: string, query: ListEntriesQuery) {
  const chart = await getChart(companyId);
  const parts = [
    ...(query.source !== "all" ? [Prisma.sql`AND h."source" IN (${Prisma.join(SOURCES[query.source])})`] : []),
    ...(query.status !== "all" ? [Prisma.sql`AND h."status" = ${query.status}`] : []),
    ...(query.month
      ? [dateFilter(Prisma.raw(`h."date"`), { from: `${query.month}-01`, to: monthRange(`${query.month}-01`).end })]
      : []),
    ...(query.q ? [Prisma.sql`AND h."text" ILIKE ${contains(query.q)}`] : []),
  ];
  const where = parts.length ? Prisma.join(parts, " ") : Prisma.empty;

  const [rows, [count]] = await Promise.all([
    prisma.$queryRaw<HeaderRow[]>`
      SELECT h."source", h."entryId", h."date", h."status", h."amount"
      FROM (${entryHeaders(companyId)}) h
      WHERE TRUE ${where}
      ORDER BY h."date" DESC, h."at" DESC, h."entryId" DESC
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
    prisma.$queryRaw<{ total: number }[]>`
      SELECT COUNT(*)::int AS "total" FROM (${entryHeaders(companyId)}) h WHERE TRUE ${where}`,
  ]);

  return {
    items: await describeEntries(companyId, chart, rows),
    total: count?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Lines, references and text for a page of entries. */
async function describeEntries(companyId: string, chart: ChartAccount[], rows: HeaderRow[]) {
  const idsOf = (...sources: EntrySource[]) => rows.filter((r) => sources.includes(r.source)).map((r) => r.entryId);
  const autoIds = [...new Set(rows.filter((r) => r.source !== "manual").map((r) => r.entryId))];

  const [lines, invoices, payments, expenses, manual] = await Promise.all([
    autoIds.length
      ? prisma.$queryRaw<{ source: EntrySource; entryId: string; key: string; debit: Decimal; credit: Decimal }[]>`
          SELECT x."source", x."entryId", x."key", x."debit", x."credit"
          FROM (${autoLines(companyId)}) x
          WHERE x."entryId" IN (${Prisma.join(autoIds)})
          ORDER BY x."position"`
      : [],
    prisma.invoice.findMany({
      where: { companyId, id: { in: idsOf("invoice") } },
      select: { id: true, number: true, numberPrefix: true, customerName: true },
    }),
    prisma.invoicePayment.findMany({
      where: { companyId, id: { in: idsOf("payment", "chequeCleared", "chequeBounced") } },
      select: {
        id: true,
        number: true,
        method: true,
        invoice: { select: { number: true, numberPrefix: true, customerName: true } },
      },
    }),
    prisma.expense.findMany({
      where: { companyId, id: { in: idsOf("expense", "expensePayment") } },
      select: { id: true, title: true, vendor: true, category: true },
    }),
    prisma.journalEntry.findMany({
      where: { companyId, id: { in: idsOf("manual") } },
      select: {
        id: true,
        number: true,
        memo: true,
        lines: { select: { accountId: true, debit: true, credit: true }, orderBy: { position: "asc" } },
      },
    }),
  ]);

  const accounts = new Map(chart.map((a) => [a.id, a]));
  const byKey = idsByKey(chart);
  const line = (accountId: string, debit: Decimal, credit: Decimal): LineDto => ({
    ...accountRef(accounts.get(accountId)!),
    debit: moneyString(new Decimal(debit)),
    credit: moneyString(new Decimal(credit)),
  });
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  const manualById = new Map(manual.map((m) => [m.id, m]));
  const invoiceRef = (i: { number: number; numberPrefix: string }) => ({
    number: i.number,
    displayNumber: `${i.numberPrefix}${i.number}`,
  });

  return rows.map((r) => {
    const base = {
      source: r.source,
      id: r.entryId,
      date: toIso(r.date),
      status: r.status,
      amount: moneyString(new Decimal(r.amount)),
      ref: null as string | null,
      memo: null as string | null,
      party: null as string | null,
      invoice: null as { number: number; displayNumber: string } | null,
      method: null as string | null,
      category: null as string | null,
    };
    if (r.source === "manual") {
      const m = manualById.get(r.entryId);
      return {
        ...base,
        ref: m ? entryNumber(m.number) : null,
        memo: m?.memo ?? null,
        lines: (m?.lines ?? []).map((l) => line(l.accountId, l.debit, l.credit)),
      };
    }
    const own = lines
      .filter((l) => l.entryId === r.entryId && l.source === r.source)
      .map((l) => line(byKey.get(l.key)!, l.debit, l.credit));
    if (r.source === "invoice") {
      const i = invoiceById.get(r.entryId);
      return { ...base, ref: i ? invoiceRef(i).displayNumber : null, party: i?.customerName ?? null, invoice: i ? invoiceRef(i) : null, lines: own };
    }
    if (r.source === "payment" || r.source === "chequeCleared" || r.source === "chequeBounced") {
      const p = paymentById.get(r.entryId);
      return {
        ...base,
        ref: p ? paymentNumber(p.number) : null,
        party: p?.invoice.customerName ?? null,
        invoice: p ? invoiceRef(p.invoice) : null,
        method: p?.method ?? null,
        lines: own,
      };
    }
    const e = expenseById.get(r.entryId);
    return { ...base, memo: e?.title ?? null, party: e?.vendor ?? null, category: e?.category ?? null, lines: own };
  });
}

// ---------------------------------------------------------------------------
// Manual entries
// ---------------------------------------------------------------------------

const entryNotFound = () => notFound("Journal entry");

/** Every account must be in this company's chart, and the debits must equal the credits. */
async function checkLines(companyId: string, lines: EntryInput["lines"]) {
  const chart = await getChart(companyId);
  const ids = new Set(chart.map((a) => a.id));
  if (lines.some((l) => !ids.has(l.accountId))) {
    throw new AppError(400, "INVALID_ACCOUNT", "Choose accounts from this company's chart", { field: "lines" });
  }
  const debit = lines.reduce((s, l) => s.plus(money(l.debit)), ZERO);
  const credit = lines.reduce((s, l) => s.plus(money(l.credit)), ZERO);
  if (!debit.equals(credit)) {
    throw new AppError(400, "ENTRY_NOT_BALANCED", "Total debit must equal total credit", {
      debit: moneyString(debit),
      credit: moneyString(credit),
    });
  }
}

const entryTotal = (lines: EntryInput["lines"]) => lines.reduce((s, l) => s.plus(money(l.debit)), ZERO);

const lineRows = (lines: EntryInput["lines"]) =>
  lines.map((l, position) => ({ position, accountId: l.accountId, debit: money(l.debit), credit: money(l.credit) }));

/** One manual entry as the journal shows it. */
export async function getEntry(companyId: string, id: string) {
  const row = await prisma.journalEntry.findFirst({
    where: { id, companyId },
    select: { id: true, date: true, status: true },
  });
  if (!row) throw entryNotFound();
  const chart = await getChart(companyId);
  const amount = await prisma.journalLine.aggregate({ where: { entryId: id }, _sum: { debit: true } });
  const [entry] = await describeEntries(companyId, chart, [
    { source: "manual", entryId: row.id, date: row.date, status: row.status, amount: amount._sum.debit ?? ZERO },
  ]);
  return entry!;
}

export async function createEntry(actor: Actor, input: EntryInput) {
  await checkLines(actor.companyId, input.lines);
  const id = await savingLines(() => prisma.$transaction(async (tx) => {
    // Taking the number locks the company row (same as invoice numbers), which
    // also holds the books open until this entry is saved.
    const company = await tx.company.update({
      where: { id: actor.companyId },
      data: { journalNextNumber: { increment: 1 } },
      select: { journalNextNumber: true, booksClosedThrough: true },
    });
    checkBooksOpen(company.booksClosedThrough, [input.date]);
    const entry = await tx.journalEntry.create({
      data: {
        number: company.journalNextNumber - 1,
        date: toDate(input.date),
        memo: input.memo,
        status: input.status,
        postedAt: input.status === "posted" ? new Date() : null,
        companyId: actor.companyId,
        createdById: actor.id,
        lines: { create: lineRows(input.lines) },
      },
      select: { id: true, number: true },
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: input.status === "draft" ? "entryDrafted" : "entryPosted",
      item: { type: "entry", id: entry.id, ref: entryNumber(entry.number) },
      values: { amount: moneyString(entryTotal(input.lines)), date: input.date, memo: input.memo },
    });
    return entry.id;
  }));
  return getEntry(actor.companyId, id);
}

/** Locks the books (shared) and the entry (for update), then checks its date is open. */
async function lockEntry(tx: Tx, companyId: string, id: string) {
  const closedThrough = await lockBooks(tx, companyId);
  const [entry] = await tx.$queryRaw<{ date: Date; status: JournalStatus; postedAt: Date | null; number: number; memo: string }[]>`
    SELECT "date", "status", "postedAt", "number", "memo" FROM "journal_entries"
    WHERE "id" = ${id} AND "companyId" = ${companyId}
    FOR UPDATE`;
  if (!entry) throw entryNotFound();
  checkBooksOpen(closedThrough, [toIso(entry.date)]);
  return { ...entry, closedThrough };
}

export async function updateEntry(actor: Actor, id: string, input: EntryInput) {
  await checkLines(actor.companyId, input.lines);
  await savingLines(() => prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, actor.companyId, id);
    checkBooksOpen(entry.closedThrough, [input.date]);
    await tx.journalLine.deleteMany({ where: { entryId: id } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "entryUpdated",
      item: { type: "entry", id, ref: entryNumber(entry.number) },
      values: { amount: moneyString(entryTotal(input.lines)), date: input.date, memo: input.memo, posted: entry.status === "draft" && input.status === "posted" ? true : undefined },
    });
    await tx.journalEntry.update({
      where: { id },
      data: {
        date: toDate(input.date),
        memo: input.memo,
        status: input.status,
        postedAt: input.status === "posted" ? (entry.postedAt ?? new Date()) : null,
        lines: { create: lineRows(input.lines) },
      },
    });
  }));
  return getEntry(actor.companyId, id);
}

export async function postEntry(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, actor.companyId, id);
    if (entry.status !== "draft") throw new AppError(409, "ENTRY_NOT_DRAFT", "This entry is already posted");
    await tx.journalEntry.update({ where: { id }, data: { status: "posted", postedAt: new Date() } });
    await audit(tx, actor.companyId, {
      action: "books",
      event: "entryPostedLater",
      item: { type: "entry", id, ref: entryNumber(entry.number) },
      values: { memo: entry.memo },
    });
  });
  return getEntry(actor.companyId, id);
}

/** Posts every draft dated in `month` (closing a month needs none left). */
export async function postDrafts(actor: Actor, month: string) {
  const { start, end } = monthRange(`${month}-01`);
  return prisma.$transaction(async (tx) => {
    checkBooksOpen(await lockBooks(tx, actor.companyId), [start]);
    const { count } = await tx.journalEntry.updateMany({
      where: { companyId: actor.companyId, status: "draft", date: { gte: toDate(start), lte: toDate(end) } },
      data: { status: "posted", postedAt: new Date() },
    });
    if (count > 0) {
      await audit(tx, actor.companyId, { action: "books", event: "draftsPosted", item: { type: "entry" }, values: { count, month } });
    }
    return { posted: count };
  });
}

export async function deleteEntry(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const entry = await lockEntry(tx, actor.companyId, id);
    await tx.journalEntry.delete({ where: { id } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "entryDeleted",
      item: { type: "entry", ref: entryNumber(entry.number) },
      values: { memo: entry.memo, date: toIso(entry.date), status: entry.status },
    });
  });
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

/**
 * Each account's net debit or credit: the movements of one month, or every
 * balance to date ("all"). Debits always equal credits; a difference would mean
 * a bug, and the page shows it in red.
 */
export async function trialBalance(companyId: string, month: string) {
  const chart = await getChart(companyId);
  const range = month === "all" ? {} : { from: `${month}-01`, to: monthRange(`${month}-01`).end };
  const [totals, drafts, months] = await Promise.all([
    accountTotals(companyId, chart, range),
    prisma.journalEntry.count({
      where: {
        companyId,
        status: "draft",
        ...(range.from && range.to ? { date: { gte: toDate(range.from), lte: toDate(range.to) } } : {}),
      },
    }),
    prisma.$queryRaw<{ month: string }[]>`
      SELECT DISTINCT to_char(h."date", 'YYYY-MM') AS "month" FROM (${entryHeaders(companyId)}) h ORDER BY 1 DESC`,
  ]);

  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows = chart.flatMap((a) => {
    const t = totals.get(a.id);
    const net = t ? t.debit.minus(t.credit) : ZERO;
    if (net.isZero()) return [];
    const debit = net.isPositive() ? net : ZERO;
    const credit = net.isNegative() ? net.negated() : ZERO;
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
    return [{ account: accountRef(a), debit: moneyString(debit), credit: moneyString(credit) }];
  });

  return {
    month,
    rows,
    totalDebit: moneyString(totalDebit),
    totalCredit: moneyString(totalCredit),
    balanced: totalDebit.equals(totalCredit),
    drafts,
    months: months.map((m) => m.month),
  };
}
