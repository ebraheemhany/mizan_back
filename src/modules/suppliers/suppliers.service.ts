// Suppliers: who the company buys from, what it has spent with each, and what it still
// owes them (its expenses saved as due). Expenses carry the supplier; this adds up.
import type { Prisma } from "../../generated/prisma/client.js";
import { toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import type { CreateSupplierInput, ListSuppliersQuery, UpdateSupplierInput } from "./suppliers.schemas.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Actor = { id: string; companyId: string };

const supplierSelect = {
  id: true,
  name: true,
  phone: true,
  email: true,
  taxNumber: true,
  notes: true,
  createdAt: true,
} satisfies Prisma.SupplierSelect;

type SupplierRow = Prisma.SupplierGetPayload<{ select: typeof supplierSelect }>;

type Totals = { billed: Decimal; due: Decimal; vat: Decimal; count: number; lastDate: string | null };
const noTotals = (): Totals => ({ billed: ZERO, due: ZERO, vat: ZERO, count: 0, lastDate: null });

const totalsDto = (t: Totals) => ({
  // Everything bought from them (VAT included), what is paid of it, and what is still owed.
  billed: moneyString(t.billed),
  paid: moneyString(t.billed.minus(t.due)),
  due: moneyString(t.due),
  vat: moneyString(t.vat),
  expensesCount: t.count,
  lastExpenseDate: t.lastDate,
});

const toDto = (row: SupplierRow, totals: Totals) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  taxNumber: row.taxNumber,
  notes: row.notes,
  createdAt: row.createdAt,
  ...totalsDto(totals),
});

/** Each supplier's totals, from their expenses. */
async function totalsOf(companyId: string, ids: string[]) {
  const map = new Map<string, Totals>(ids.map((id) => [id, noTotals()]));
  if (ids.length === 0) return map;
  const rows = await prisma.expense.groupBy({
    by: ["supplierId", "status"],
    where: { companyId, supplierId: { in: ids } },
    _sum: { amount: true, vat: true },
    _count: true,
    _max: { date: true },
  });
  for (const row of rows) {
    const t = map.get(row.supplierId!)!;
    const amount = row._sum.amount ?? ZERO;
    t.billed = t.billed.plus(amount);
    if (row.status === "due") t.due = t.due.plus(amount);
    t.vat = t.vat.plus(row._sum.vat ?? ZERO);
    t.count += row._count;
    const last = row._max.date ? toIso(row._max.date) : null;
    if (last && (!t.lastDate || last > t.lastDate)) t.lastDate = last;
  }
  return map;
}

async function findSupplier(db: Db, companyId: string, id: string) {
  const row = await db.supplier.findFirst({ where: { id, companyId }, select: supplierSelect });
  if (!row) throw notFound("Supplier");
  return row;
}

/** Another supplier with the same name (case and spaces aside) is refused: one list entry each. */
async function assertNameFree(db: Db, companyId: string, name: string, exceptId?: string) {
  const same = await db.supplier.findFirst({
    where: { companyId, name: { equals: name.trim(), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (same) throw new AppError(409, "SUPPLIER_EXISTS", "There is already a supplier with this name", { field: "name", id: same.id });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Every supplier (by name), with what was bought and what is owed; the total owed on top. */
export async function listSuppliers(companyId: string, query: ListSuppliersQuery) {
  const rows = await prisma.supplier.findMany({
    where: {
      companyId,
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { phone: { contains: query.q } },
              { email: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: supplierSelect,
    orderBy: { name: "asc" },
    take: 1000,
  });
  const totals = await totalsOf(companyId, rows.map((r) => r.id));
  const items = rows.map((r) => toDto(r, totals.get(r.id)!));
  const owed = [...totals.values()].reduce((sum, t) => sum.plus(t.due), ZERO);
  return {
    items,
    totals: { count: items.length, due: moneyString(owed), owedTo: items.filter((i) => i.due !== "0.00").length },
  };
}

/** One supplier: details, totals, and their expenses (the statement), newest first. */
export async function getSupplier(companyId: string, id: string) {
  const row = await findSupplier(prisma, companyId, id);
  const [totals, expenses] = await Promise.all([
    totalsOf(companyId, [id]),
    prisma.expense.findMany({
      where: { companyId, supplierId: id },
      select: {
        id: true,
        title: true,
        category: true,
        amount: true,
        vat: true,
        date: true,
        status: true,
        dueDate: true,
        paidOn: true,
        paidFrom: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 500,
    }),
  ]);
  return {
    ...toDto(row, totals.get(id)!),
    expenses: expenses.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      amount: moneyString(e.amount),
      vat: moneyString(e.vat),
      date: toIso(e.date),
      status: e.status,
      dueDate: e.dueDate ? toIso(e.dueDate) : null,
      paidOn: e.paidOn ? toIso(e.paidOn) : null,
      paidFrom: e.paidFrom,
    })),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createSupplier(actor: Actor, input: CreateSupplierInput) {
  const row = await prisma.$transaction(async (tx) => {
    await assertNameFree(tx, actor.companyId, input.name);
    const created = await tx.supplier.create({
      data: {
        name: input.name,
        phone: input.phone ?? null,
        email: input.email ?? null,
        taxNumber: input.taxNumber ?? null,
        notes: input.notes ?? null,
        companyId: actor.companyId,
      },
      select: supplierSelect,
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: "supplierAdded",
      item: { type: "supplier", id: created.id, ref: created.name },
      values: { name: created.name },
    });
    return created;
  });
  return toDto(row, noTotals());
}

export async function updateSupplier(actor: Actor, id: string, input: UpdateSupplierInput) {
  await prisma.$transaction(async (tx) => {
    const before = await findSupplier(tx, actor.companyId, id);
    if (input.name !== undefined) await assertNameFree(tx, actor.companyId, input.name, id);
    const data: Prisma.SupplierUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    for (const key of ["phone", "email", "taxNumber", "notes"] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    const changed = Object.keys(data).filter((k) => data[k as keyof typeof data] !== before[k as keyof SupplierRow]);
    if (changed.length === 0) return;
    await tx.supplier.update({ where: { id }, data });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "supplierUpdated",
      item: { type: "supplier", id, ref: input.name ?? before.name },
      values: { fields: changed },
    });
  });
  return getSupplier(actor.companyId, id);
}

/** Only a supplier with no expenses: one with history stays (its expenses point to it). */
export async function deleteSupplier(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const row = await findSupplier(tx, actor.companyId, id);
    const used = await tx.expense.count({ where: { companyId: actor.companyId, supplierId: id } });
    if (used > 0) {
      throw new AppError(409, "SUPPLIER_HAS_EXPENSES", "This supplier has expenses; it can't be deleted", { count: used });
    }
    await tx.supplier.delete({ where: { id } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "supplierDeleted",
      item: { type: "supplier", id, ref: row.name },
      values: { name: row.name },
    });
  });
}

/**
 * The supplier an expense is for: the one picked (it must be the company's), else the one
 * with the name typed, added to the list when there is none. Null when neither is given.
 */
export async function supplierFor(
  db: Db,
  companyId: string,
  input: { supplierId?: string | null | undefined; vendor?: string | null | undefined },
) {
  if (input.supplierId) {
    const row = await db.supplier.findFirst({ where: { id: input.supplierId, companyId }, select: { id: true, name: true } });
    if (!row) throw new AppError(400, "INVALID_SUPPLIER", "That supplier isn't in this company's list", { field: "supplierId" });
    return row;
  }
  const name = input.vendor?.trim();
  if (!name) return null;
  const same = await db.supplier.findFirst({
    where: { companyId, name: { equals: name, mode: "insensitive" } },
    select: { id: true, name: true },
  });
  return same ?? db.supplier.create({ data: { name, companyId }, select: { id: true, name: true } });
}
