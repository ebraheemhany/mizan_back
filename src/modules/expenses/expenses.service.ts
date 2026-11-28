import type { ExpenseSource, Prisma, Role } from "../../generated/prisma/client.js";
import { businessToday, monthRange, toDate, toIso, yearRange } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { can, type Permission } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { assertBooksOpen, checkBooksOpen, lockBooks } from "../ledger/ledger.periods.js";
import { audit } from "../audit/audit.service.js";
import { revenueByMonth } from "../reports/revenue.js";
import { supplierFor } from "../suppliers/suppliers.service.js";
import type { CreateExpenseInput, ListExpensesQuery } from "./expenses.schemas.js";

type Actor = { id: string; companyId: string; role: Role; permissions: readonly Permission[] };
const EXPORT_LIMIT = 5000;
/** The one who added an expense may remove it for this long ("undo"); after that only the owner can. */
export const UNDO_WINDOW_MS = 15 * 60 * 1000;

const expenseSelect = {
  id: true,
  title: true,
  category: true,
  amount: true,
  date: true,
  status: true,
  paidFrom: true,
  paidAt: true,
  dueDate: true,
  vendor: true,
  vat: true,
  supplier: { select: { id: true, name: true } },
  createdAt: true,
  createdById: true,
  receipt: { select: { contentType: true, size: true, name: true } },
} satisfies Prisma.ExpenseSelect;

type ExpenseRow = Prisma.ExpenseGetPayload<{ select: typeof expenseSelect }>;

function toDto(row: ExpenseRow) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    amount: moneyString(row.amount),
    date: toIso(row.date),
    status: row.status,
    paidFrom: row.paidFrom,
    paidAt: row.paidAt,
    dueDate: row.dueDate ? toIso(row.dueDate) : null,
    vendor: row.vendor,
    // The supplier as it is now (null: none, or removed; vendor keeps the name it had).
    supplier: row.supplier,
    vat: moneyString(row.vat),
    createdAt: row.createdAt,
    // The attached receipt (GET /api/expenses/:id/receipt); null when there is none.
    receipt: row.receipt,
  };
}

export type ExpenseDto = ReturnType<typeof toDto>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function periodRange(period: ListExpensesQuery["period"], today: string) {
  if (period === "thisMonth") return monthRange(today);
  if (period === "lastMonth") return monthRange(today, -1);
  if (period === "thisYear") return yearRange(today);
  return null;
}

function buildWhere(companyId: string, query: Omit<ListExpensesQuery, "page" | "pageSize">) {
  const and: Prisma.ExpenseWhereInput[] = [{ companyId }];
  if (query.category !== "all") and.push({ category: query.category });
  if (query.status !== "all") and.push({ status: query.status });
  const range = periodRange(query.period, businessToday());
  if (range) and.push({ date: { gte: toDate(range.start), lte: toDate(range.end) } });
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" } as const;
    and.push({ OR: [{ title: contains }, { vendor: contains }, { supplier: { name: contains } }] });
  }
  return { AND: and } satisfies Prisma.ExpenseWhereInput;
}

const ORDER_BY: Prisma.ExpenseOrderByWithRelationInput[] = [{ date: "desc" }, { createdAt: "desc" }];

export async function listExpenses(companyId: string, query: ListExpensesQuery) {
  const where = buildWhere(companyId, query);
  const [rows, total, all] = await prisma.$transaction([
    prisma.expense.findMany({
      where,
      select: expenseSelect,
      orderBy: ORDER_BY,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.expense.count({ where }),
    prisma.expense.count({ where: { companyId } }),
  ]);
  return { items: rows.map(toDto), total, all, page: query.page, pageSize: query.pageSize };
}

export async function exportExpenses(companyId: string, query: ListExpensesQuery) {
  const rows = await prisma.expense.findMany({
    where: buildWhere(companyId, query),
    select: expenseSelect,
    orderBy: ORDER_BY,
    take: EXPORT_LIMIT,
  });
  return rows.map(toDto);
}

/**
 * Total expenses per month ("YYYY-MM"), counted by the expense's date, paid and
 * due alike (the same rule the expenses page and the dashboard use).
 */
export async function expensesByMonth(companyId: string, from: string) {
  const rows = await prisma.$queryRaw<{ month: string; total: Decimal }[]>`
    -- The cost: what was paid, less the VAT in it (that is claimed back, not spent).
    SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month, SUM("amount" - "vat") AS total
    FROM "expenses"
    WHERE "companyId" = ${companyId}
      AND "date" >= ${toDate(from)}::date
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.month, new Decimal(r.total)]));
}

/** Change in percent, or null when there is nothing to compare with. */
export const changePct = (now: Decimal, before: Decimal) =>
  before.isZero() ? null : now.minus(before).dividedBy(before.abs()).times(100).round().toNumber();

/** The cards and the category breakdown on the expenses page (current month). */
export async function expenseStats(companyId: string) {
  const today = businessToday();
  const month = monthRange(today);
  const prev = monthRange(today, -1);

  const [byMonth, byCategory, due, dueVendors, revenueOfMonth] = await Promise.all([
    expensesByMonth(companyId, prev.start),
    prisma.expense.groupBy({
      by: ["category"],
      where: { companyId, date: { gte: toDate(month.start), lte: toDate(month.end) } },
      _sum: { amount: true, vat: true },
    }),
    prisma.expense.aggregate({ where: { companyId, status: "due" }, _sum: { amount: true }, _count: true }),
    // Distinct suppliers owed money (an expense with none counts on its own).
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(DISTINCT COALESCE("supplierId", "vendor", "id"))::int AS count
      FROM "expenses" WHERE "companyId" = ${companyId} AND "status" = 'due'`,
    // Revenue of the month, the dashboard's definition (shared helper).
    revenueByMonth(companyId, month),
  ]);

  const revenue = revenueOfMonth.get(month.start.slice(0, 7)) ?? ZERO;
  const total = byMonth.get(month.start.slice(0, 7)) ?? ZERO;
  const prevTotal = byMonth.get(prev.start.slice(0, 7)) ?? ZERO;
  const categories = byCategory
    .map((c) => ({ category: c.category, amount: (c._sum.amount ?? ZERO).minus(c._sum.vat ?? ZERO) }))
    // Largest first; equal amounts by category name, so the order never jumps around.
    .sort((a, b) => b.amount.comparedTo(a.amount) || a.category.localeCompare(b.category));

  return {
    month: month.start.slice(0, 7),
    total: moneyString(total),
    prevTotal: moneyString(prevTotal),
    changePct: changePct(total, prevTotal),
    byCategory: categories.map((c) => ({
      category: c.category,
      amount: moneyString(c.amount),
      // Share of the month's total, in percent.
      share: total.isZero() ? 0 : c.amount.dividedBy(total).times(100).round().toNumber(),
    })),
    due: moneyString(due._sum.amount ?? ZERO),
    dueCount: due._count,
    dueVendors: dueVendors[0]?.count ?? 0,
    revenue: moneyString(revenue),
    netProfit: moneyString(revenue.minus(total)),
  };
}

/** Unpaid expenses, soonest due first (for the notifications menu). */
export async function dueExpenses(companyId: string) {
  const rows = await prisma.expense.findMany({
    where: { companyId, status: "due" },
    select: expenseSelect,
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { date: "asc" }],
    take: 50,
  });
  return rows.map(toDto);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createExpense(actor: Actor, input: CreateExpenseInput) {
  const paid = input.status === "paid";
  const row = await prisma.$transaction(async (tx) => {
    // It goes into the books on its date, which must be open.
    await assertBooksOpen(tx, actor.companyId, [input.date]);
    // The supplier picked, or the one with the name typed (added to the list if new).
    const supplier = await supplierFor(tx, actor.companyId, input);
    const created = await tx.expense.create({
      data: {
        title: input.title,
        category: input.category,
        amount: money(input.amount),
        date: toDate(input.date),
        status: input.status,
        paidFrom: paid ? (input.paidFrom ?? null) : null,
        paidAt: paid ? new Date() : null,
        // Saved as paid: paid on its own date.
        paidOn: paid ? toDate(input.date) : null,
        dueDate: !paid && input.dueDate ? toDate(input.dueDate) : null,
        vendor: supplier?.name ?? null,
        supplierId: supplier?.id ?? null,
        vat: money(input.vat ?? "0"),
        companyId: actor.companyId,
        createdById: actor.id,
      },
      select: expenseSelect,
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: paid ? "expenseAdded" : "expenseAddedDue",
      item: { type: "expense", id: created.id, ref: created.title },
      values: {
        amount: moneyString(created.amount),
        category: created.category,
        vendor: created.vendor ?? undefined,
        ...(created.vat.gt(0) ? { vat: moneyString(created.vat) } : {}),
      },
    });
    return created;
  });
  return toDto(row);
}

/** A due expense has been paid. */
export async function payExpense(actor: Actor, id: string, paidFrom: ExpenseSource) {
  const count = await prisma.$transaction(async (tx) => {
    const { count } = await tx.expense.updateMany({
      where: { id, companyId: actor.companyId, status: "due" },
      data: { status: "paid", paidFrom, paidAt: new Date(), paidOn: toDate(businessToday()) },
    });
    if (count === 0) return 0;
    const expense = await tx.expense.findUniqueOrThrow({ where: { id }, select: { title: true, amount: true } });
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "expensePaid",
      item: { type: "expense", id, ref: expense.title },
      values: { amount: moneyString(expense.amount), paidFrom },
    });
    return count;
  });
  if (count === 0) {
    await getExpense(actor.companyId, id); // 404 if it isn't ours
    throw new AppError(409, "EXPENSE_NOT_DUE", "This expense is already paid");
  }
  return getExpense(actor.companyId, id);
}

async function getExpense(companyId: string, id: string) {
  const row = await prisma.expense.findFirst({ where: { id, companyId }, select: expenseSelect });
  if (!row) throw notFound("Expense");
  return toDto(row);
}

/**
 * Deleting financial records is for the owner. The person who just added an
 * expense may also remove it within a short window (the "undo" after adding).
 */
export async function deleteExpense(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const closedThrough = await lockBooks(tx, actor.companyId);
    const row = await tx.expense.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true, createdById: true, createdAt: true, date: true, paidOn: true, title: true, amount: true, receiptFileId: true },
    });
    if (!row) throw notFound("Expense");

    const isOwnRecent = row.createdById === actor.id && Date.now() - row.createdAt.getTime() <= UNDO_WINDOW_MS;
    if (!can(actor, "deleteData") && !isOwnRecent) {
      throw new AppError(403, "FORBIDDEN", "Only the owner can delete an expense after it has been saved");
    }
    // Its entries leave the books on their dates, which must be open.
    checkBooksOpen(closedThrough, [toIso(row.date), row.paidOn ? toIso(row.paidOn) : null]);
    // deleteMany + count: a delete that lost a race with another one is a 404, not a 500.
    const { count } = await tx.expense.deleteMany({ where: { id: row.id, companyId: actor.companyId } });
    if (count === 0) throw notFound("Expense");
    if (row.receiptFileId) await tx.storedFile.deleteMany({ where: { id: row.receiptFileId, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "expenseDeleted",
      item: { type: "expense", ref: row.title },
      values: { amount: moneyString(row.amount) },
    });
  });
}
