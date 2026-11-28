// Stock: every change to a product's stock goes through here and is logged in stock_movements,
// with the balance right after it. Sales and returns come from invoices and credit notes
// (issued invoice: out; cancelled: back in; credit note "return": back in); goods received,
// counts and damage are recorded by hand on the product.
//
// Selling more than is on hand is allowed (the balance goes below zero and shows as such):
// the sale happened, and blocking the invoice would only push people to skip the system.
//
// Cost (weighted average): a product's cost is the average of what's on hand. Goods received
// at a cost (a purchase, recorded as its expense) raise or lower it; everything that goes out
// leaves at it, and each movement keeps its unit cost and the value it moved (signed: + into
// inventory, - out). In the books (ledger.sql "stock"): sales and their reversals move value
// between inventory and the cost of goods sold, counts and damage to stock losses, opening
// stock and a new cost on what's on hand to capital; a purchase's expense is inventory.
import { z } from "zod";
import { Prisma, type StockMovementKind } from "../../generated/prisma/client.js";
import { businessToday, toDate, toIso } from "../../lib/dates.js";

type Range = { start: string; end: string };
import { AppError } from "../../lib/errors.js";
import { Decimal, money, moneyString, ZERO, type DecimalLike } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { addExpense } from "../expenses/expenses.service.js";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; companyId: string };

/** Quantities of stock: up to 3 decimals (kilos, metres), as strings for Decimal. */
export const quantityString = (q: DecimalLike) => new Decimal(q).toDecimalPlaces(3).toFixed(3);
/** For the API: a plain number (3 decimals at most), null for services. */
export const stockNumber = (q: Prisma.Decimal | null) => (q === null ? null : Number(q.toDecimalPlaces(3)));
/** A unit cost for the API: 4 decimals at most, null when unknown. */
export const costString = (c: Prisma.Decimal | null) => (c === null ? null : c.toDecimalPlaces(4).toString());
const cost4 = (d: Prisma.Decimal) => d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

/** Movements that are sales (and their reversals): their value is the cost of goods sold. */
export const SALES_KINDS = ["sale", "saleCancelled", "returned", "returnRemoved"] as const;
/** Movements that are stock gained or lost by hand: their value is a stock loss (or gain). */
export const LOSS_KINDS = ["counted", "damaged"] as const;

type Meta = {
  kind: StockMovementKind;
  /** yyyy-mm-dd */
  date: string;
  userId: string | null;
  invoiceId?: string;
  creditNoteId?: string;
  note?: string | null;
};

/** How a movement is costed: at the product's average (the default), at a given unit cost, or a given value. */
type Costing = { unitCost: Prisma.Decimal | null; value?: Prisma.Decimal | null } | "average" | "none";

/**
 * Moves stock for the catalog products among `lines` (+ in, - out per `sign`); lines with no
 * product, and services, are skipped. One movement per product (quantities on several lines of
 * the same product are added up), at the product's average cost. Products are updated in id
 * order, so two transactions moving the same products never wait on each other in a circle.
 *
 * costFromInvoice: a return comes back at what it cost when that invoice sold it.
 */
export async function moveStock(
  tx: Tx,
  companyId: string,
  lines: { productId?: string | null | undefined; quantity: DecimalLike }[],
  sign: 1 | -1,
  meta: Meta & { costFromInvoice?: string },
) {
  const totals = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    if (!line.productId) continue;
    totals.set(line.productId, (totals.get(line.productId) ?? new Decimal(0)).plus(new Decimal(line.quantity)));
  }
  if (totals.size === 0) return;
  const tracked = await tx.product.findMany({
    where: { companyId, id: { in: [...totals.keys()] }, type: "product" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const soldAt = meta.costFromInvoice ? await saleCosts(tx, companyId, meta.costFromInvoice) : new Map<string, Prisma.Decimal>();
  for (const { id } of tracked) {
    const delta = totals.get(id)!.times(sign);
    if (delta.isZero()) continue;
    const unitCost = soldAt.get(id);
    await apply(tx, companyId, id, delta, meta, unitCost ? { unitCost } : "average");
  }
}

/** What each product cost when an invoice sold it (its sale movements' average unit cost). */
async function saleCosts(tx: Tx, companyId: string, invoiceId: string) {
  const rows = await tx.stockMovement.findMany({
    where: { companyId, invoiceId, kind: "sale", value: { not: null } },
    select: { productId: true, quantity: true, value: true },
  });
  const sums = new Map<string, { qty: Prisma.Decimal; value: Prisma.Decimal }>();
  for (const r of rows) {
    const s = sums.get(r.productId) ?? { qty: ZERO, value: ZERO };
    sums.set(r.productId, { qty: s.qty.plus(r.quantity), value: s.value.plus(r.value!) });
  }
  return new Map([...sums].flatMap(([id, s]) => (s.qty.isZero() ? [] : [[id, cost4(s.value.dividedBy(s.qty))] as const])));
}

/**
 * One product's stock changes by `delta`; logged with the balance after it, its unit cost and
 * the value it moved. Goods coming in at a known cost move the average; what goes out leaves
 * at the average. The product row is locked first (the average is read and written in turn).
 */
async function apply(tx: Tx, companyId: string, productId: string, delta: Prisma.Decimal, meta: Meta, costing: Costing = "average", expenseId?: string) {
  const [row] = await tx.$queryRaw<{ stock: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]>`
    SELECT "stock", "cost" FROM "products" WHERE "id" = ${productId} FOR UPDATE`;
  const before = new Decimal(row?.stock ?? 0);
  const average = row?.cost === null || row?.cost === undefined ? null : new Decimal(row.cost);

  let unitCost: Prisma.Decimal | null = null;
  let value: Prisma.Decimal | null = null;
  if (costing === "average") {
    unitCost = average;
  } else if (costing !== "none") {
    unitCost = costing.unitCost;
    if (costing.value !== undefined && costing.value !== null) value = costing.value;
  }
  if (value === null && unitCost !== null) value = money(delta.times(unitCost));

  // The new average: what's on hand (never less than nothing) plus what came in, at its value.
  let nextCost = average;
  const incoming = delta.gt(0) && value !== null && costing !== "average";
  if (incoming) {
    const onHand = Decimal.max(before, ZERO);
    nextCost = average === null || onHand.isZero() ? cost4(value!.dividedBy(delta)) : cost4(onHand.times(average).plus(value!).dividedBy(onHand.plus(delta)));
  } else if (meta.kind === "receiptRemoved" && value !== null && average !== null) {
    // Undoing goods received: the average as if they never came (when some stock is left).
    const left = before.plus(delta);
    if (left.gt(0)) {
      const back = before.times(average).plus(value).dividedBy(left);
      if (back.gte(0)) nextCost = cost4(back);
    }
  }

  const stock = before.plus(delta);
  await tx.product.update({ where: { id: productId }, data: { stock, ...(nextCost !== average ? { cost: nextCost } : {}) } });
  return tx.stockMovement.create({
    data: {
      kind: meta.kind,
      date: toDate(meta.date),
      quantity: delta,
      balance: stock,
      unitCost,
      value,
      note: meta.note ?? null,
      createdById: meta.userId,
      companyId,
      productId,
      invoiceId: meta.invoiceId ?? null,
      creditNoteId: meta.creditNoteId ?? null,
      expenseId: expenseId ?? null,
    },
    select: { id: true },
  });
}

/**
 * Puts back what an earlier set of movements took out (or takes back what it put in): the
 * invoice's sales when it's cancelled, a credit note's returns when it's deleted. Uses the
 * movements themselves (their quantities and values), so an invoice issued before stock was
 * tracked moves nothing, and what comes back comes back at what it went out at.
 */
export async function reverseMovements(
  tx: Tx,
  companyId: string,
  where: { invoiceId: string; kind: "sale" } | { creditNoteId: string; kind: "returned" },
  meta: Omit<Meta, "invoiceId" | "creditNoteId">,
) {
  const rows = await tx.stockMovement.findMany({
    where: { companyId, ...where },
    select: { productId: true, quantity: true, value: true },
    orderBy: { productId: "asc" },
  });
  const sums = new Map<string, { qty: Prisma.Decimal; value: Prisma.Decimal | null }>();
  for (const r of rows) {
    const s = sums.get(r.productId) ?? { qty: ZERO, value: ZERO };
    sums.set(r.productId, { qty: s.qty.plus(r.quantity), value: s.value === null || r.value === null ? null : s.value.plus(r.value) });
  }
  const owner = "invoiceId" in where ? { invoiceId: where.invoiceId } : { creditNoteId: where.creditNoteId };
  for (const [productId, s] of sums) {
    if (s.qty.isZero()) continue;
    const delta = s.qty.negated();
    const costing: Costing = s.value === null ? "none" : { unitCost: cost4(s.value.dividedBy(s.qty)), value: s.value.negated() };
    await apply(tx, companyId, productId, delta, { ...meta, ...owner }, costing);
  }
}

/** An invoice's lines, for its stock to go out when it is issued. */
export const linesOf = (tx: Tx, invoiceId: string) =>
  tx.invoiceLine.findMany({ where: { invoiceId }, select: { productId: true, quantity: true } });

// ---------------------------------------------------------------------------
// A product's cost set by hand, and opening stock
// ---------------------------------------------------------------------------

/**
 * A new cost for a product. With stock on hand, what's on hand is valued again at it (a
 * "costed" movement of quantity 0 moves the difference, against capital in the books).
 */
export async function setCost(tx: Tx, companyId: string, productId: string, cost: Prisma.Decimal, userId: string | null) {
  const [row] = await tx.$queryRaw<{ stock: Prisma.Decimal | null; cost: Prisma.Decimal | null; type: string }[]>`
    SELECT "stock", "cost", "type" FROM "products" WHERE "id" = ${productId} FOR UPDATE`;
  if (!row) return;
  const next = cost4(cost);
  if (row.cost !== null && new Decimal(row.cost).equals(next)) return;
  await tx.product.update({ where: { id: productId }, data: { cost: next } });
  const stock = new Decimal(row.stock ?? 0);
  if (row.type !== "product" || stock.lte(0)) return;
  // What's on hand is worth stock × the new cost; the books hold the sum of the values moved.
  const held = await tx.stockMovement.aggregate({ where: { productId }, _sum: { value: true } });
  const value = money(stock.times(next)).minus(held._sum.value ?? ZERO);
  if (value.isZero()) return;
  await tx.stockMovement.create({
    data: {
      kind: "costed",
      date: toDate(businessToday()),
      quantity: 0,
      balance: stock,
      unitCost: next,
      value,
      createdById: userId,
      companyId,
      productId,
    },
  });
}

/** A new product's stock on hand when it's added: its opening, at its cost when given. */
export async function openStock(tx: Tx, companyId: string, productId: string, quantity: DecimalLike, cost: Prisma.Decimal | null, userId: string | null) {
  const delta = new Decimal(quantity);
  if (delta.isZero()) {
    if (cost !== null) await tx.product.update({ where: { id: productId }, data: { cost: cost4(cost) } });
    return;
  }
  await apply(tx, companyId, productId, delta, { kind: "opening", date: businessToday(), userId }, cost === null ? "none" : { unitCost: cost4(cost) });
}

// ---------------------------------------------------------------------------
// By hand: goods received (at a cost: a purchase), a count, damage
// ---------------------------------------------------------------------------

const quantity = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Must be a non-negative number with up to 3 decimals"),
);
const decimal = (dp: number) =>
  z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") || undefined : v),
    z.string().regex(new RegExp(`^\\d{1,10}(\\.\\d{1,${dp}})?$`), `Must be a non-negative number with up to ${dp} decimals`),
  );
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const adjustStockSchema = z
  .object({
    /** received: + quantity; damaged: - quantity; counted: quantity is what was counted on hand. */
    kind: z.enum(["received", "counted", "damaged"]),
    quantity,
    date: isoDate.optional(),
    note: z
      .string()
      .trim()
      .max(300)
      .optional()
      .transform((v) => v || undefined),
    // Goods received at a cost are a purchase: what one unit cost (VAT excluded), how it was
    // paid (or "due": owed to the supplier), from whom, and the VAT on it.
    unitCost: decimal(4).optional(),
    paidFrom: z.enum(["cash", "bank", "card", "due"]).optional(),
    vendor: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((v) => v || undefined),
    supplierId: z.uuid().optional(),
    dueDate: isoDate.optional(),
    vat: decimal(2).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.unitCost !== undefined && v.kind !== "received") ctx.addIssue({ code: "custom", path: ["unitCost"], message: "Only goods received have a purchase cost" });
    if (v.unitCost !== undefined && !v.paidFrom) ctx.addIssue({ code: "custom", path: ["paidFrom"], message: "Say how the goods were paid" });
    if (v.dueDate && v.paidFrom !== "due") ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Only a purchase owed has a due date" });
  });
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export async function adjustStock(actor: Actor, productId: string, input: AdjustStockInput) {
  const today = businessToday();
  const date = input.date ?? today;
  if (date > today) throw new AppError(400, "STOCK_DATE_IN_FUTURE", "The date can't be in the future", { field: "date" });
  const amount = new Decimal(input.quantity);
  if (input.kind !== "counted" && amount.isZero()) {
    throw new AppError(400, "VALIDATION_ERROR", "Enter a quantity", { field: "quantity" });
  }

  await prisma.$transaction(async (tx) => {
    // Locks the product row until this ends, so the count's difference is against a stock
    // nobody changes meanwhile.
    const [product] = await tx.$queryRaw<{ id: string; name: string; type: string; stock: Prisma.Decimal | null }[]>`
      SELECT "id", "name", "type", "stock" FROM "products"
      WHERE "id" = ${productId} AND "companyId" = ${actor.companyId}
      FOR UPDATE`;
    if (!product) throw notFound("Product");
    if (product.type !== "product") {
      throw new AppError(409, "NOT_STOCKED", "Services have no stock", { field: "kind" });
    }
    const before = new Decimal(product.stock ?? 0);
    const delta =
      input.kind === "received" ? amount : input.kind === "damaged" ? amount.negated() : amount.minus(before);
    let purchase: { id: string; amount: string } | null = null;
    if (delta.isZero()) {
      // A count that matches: logged as such (the count happened), nothing moves.
      await tx.stockMovement.create({
        data: {
          kind: "counted",
          date: toDate(date),
          quantity: 0,
          balance: before,
          note: input.note ?? null,
          createdById: actor.id,
          companyId: actor.companyId,
          productId,
        },
      });
    } else if (input.kind === "received" && input.unitCost !== undefined) {
      // A purchase: its expense (paid or owed) is the inventory it brought in.
      const unitCost = new Decimal(input.unitCost);
      const value = money(delta.times(unitCost));
      const vat = money(input.vat ?? "0");
      const due = input.paidFrom === "due";
      const expense = await addExpense(tx, actor, {
        title: `${product.name} × ${stockNumber(delta)}`,
        category: "purchases",
        amount: moneyString(value.plus(vat)),
        date,
        status: due ? "due" : "paid",
        paidFrom: due ? null : (input.paidFrom as "cash" | "bank" | "card"),
        dueDate: due ? (input.dueDate ?? null) : null,
        supplierId: input.supplierId ?? null,
        vendor: input.vendor ?? null,
        vat: moneyString(vat),
      });
      purchase = { id: expense.id, amount: moneyString(expense.amount) };
      await apply(tx, actor.companyId, productId, delta, { kind: "received", date, userId: actor.id, note: input.note ?? null }, { unitCost: cost4(unitCost), value }, expense.id);
    } else {
      // Received with no cost: no value in the books (and the average stays).
      const costing: Costing = input.kind === "received" ? "none" : "average";
      await apply(tx, actor.companyId, productId, delta, { kind: input.kind, date, userId: actor.id, note: input.note ?? null }, costing);
    }
    await audit(tx, actor.companyId, {
      action: "update",
      event: "stockAdjusted",
      item: { type: "product", id: productId, ref: product.name },
      values: {
        kind: input.kind,
        quantity: quantityString(delta),
        from: quantityString(before),
        to: quantityString(before.plus(delta)),
        ...(purchase ? { amount: purchase.amount } : {}),
      },
    });
  });
}

/**
 * The purchase that goods were received with is being deleted: the receipt is undone (the
 * goods go out at what they came in at). Called inside the expense's deletion.
 */
export async function undoReceipt(tx: Tx, companyId: string, expenseId: string, userId: string) {
  const receipt = await tx.stockMovement.findFirst({
    where: { companyId, expenseId, kind: "received" },
    select: { productId: true, quantity: true, unitCost: true, value: true },
  });
  if (!receipt) return;
  await apply(
    tx,
    companyId,
    receipt.productId,
    receipt.quantity.negated(),
    { kind: "receiptRemoved", date: businessToday(), userId },
    { unitCost: receipt.unitCost, value: receipt.value === null ? null : receipt.value.negated() },
  );
}

// ---------------------------------------------------------------------------
// What stock cost in a period (for the profit and loss)
// ---------------------------------------------------------------------------

/** Per month ("YYYY-MM"): the cost of goods sold and the stock lost (gains negative), from `from` on. */
export async function stockCostByMonth(companyId: string, from: string) {
  const rows = await prisma.$queryRaw<{ month: string; sold: Prisma.Decimal; lost: Prisma.Decimal }[]>`
    SELECT to_char(date_trunc('month', "date"), 'YYYY-MM') AS month,
      -SUM(CASE WHEN "kind"::text IN ('sale', 'saleCancelled', 'returned', 'returnRemoved') THEN "value" ELSE 0 END) AS sold,
      -SUM(CASE WHEN "kind"::text IN ('counted', 'damaged') THEN "value" ELSE 0 END) AS lost
    FROM "stock_movements"
    WHERE "companyId" = ${companyId} AND "value" IS NOT NULL AND "date" >= ${toDate(from)}::date
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.month, { sold: new Decimal(r.sold), lost: new Decimal(r.lost) }]));
}

/** The cost of goods sold and the stock lost in a period. */
export async function stockCostIn(companyId: string, range: Range) {
  const rows = await prisma.$queryRaw<{ sold: Prisma.Decimal | null; lost: Prisma.Decimal | null }[]>`
    SELECT
      -SUM(CASE WHEN "kind"::text IN ('sale', 'saleCancelled', 'returned', 'returnRemoved') THEN "value" ELSE 0 END) AS sold,
      -SUM(CASE WHEN "kind"::text IN ('counted', 'damaged') THEN "value" ELSE 0 END) AS lost
    FROM "stock_movements"
    WHERE "companyId" = ${companyId} AND "value" IS NOT NULL
      AND "date" BETWEEN ${toDate(range.start)}::date AND ${toDate(range.end)}::date`;
  return { sold: new Decimal(rows[0]?.sold ?? 0), lost: new Decimal(rows[0]?.lost ?? 0) };
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export const movementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** A product's movements, newest first, with what each came from. */
export async function listMovements(companyId: string, productId: string, query: z.infer<typeof movementsQuerySchema>) {
  const product = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true } });
  if (!product) throw notFound("Product");
  const where = { companyId, productId } satisfies Prisma.StockMovementWhereInput;
  const [rows, total] = await prisma.$transaction([
    prisma.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        kind: true,
        date: true,
        quantity: true,
        balance: true,
        unitCost: true,
        value: true,
        note: true,
        createdAt: true,
        createdById: true,
        invoice: { select: { number: true, numberPrefix: true, customerName: true } },
        creditNote: { select: { number: true, invoice: { select: { number: true, numberPrefix: true, customerName: true } } } },
        expense: { select: { id: true, vendor: true, status: true } },
      },
    }),
    prisma.stockMovement.count({ where }),
  ]);
  const userIds = [...new Set(rows.flatMap((r) => (r.createdById ? [r.createdById] : [])))];
  const users = new Map(
    (await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })).map((u) => [
      u.id,
      u.fullName,
    ]),
  );
  return {
    items: rows.map((r) => {
      const invoice = r.invoice ?? r.creditNote?.invoice ?? null;
      return {
        id: r.id,
        kind: r.kind,
        date: toIso(r.date),
        quantity: quantityString(r.quantity),
        balance: quantityString(r.balance),
        unitCost: costString(r.unitCost),
        value: r.value === null ? null : moneyString(r.value),
        note: r.note,
        at: r.createdAt.toISOString(),
        by: r.createdById ? (users.get(r.createdById) ?? null) : null,
        // Where it came from: the invoice (its number for the link), or the credit note on one.
        invoice: invoice ? { number: invoice.number, displayNumber: `${invoice.numberPrefix}${invoice.number}`, customer: invoice.customerName } : null,
        creditNote: r.creditNote ? `CN-${String(r.creditNote.number).padStart(4, "0")}` : null,
        // Goods received as a purchase: its supplier, and whether it's still owed.
        purchase: r.expense ? { id: r.expense.id, vendor: r.expense.vendor, due: r.expense.status === "due" } : null,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
