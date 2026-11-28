// Stock: every change to a product's stock goes through here and is logged in stock_movements,
// with the balance right after it. Sales and returns come from invoices and credit notes
// (issued invoice: out; cancelled: back in; credit note "return": back in); goods received,
// counts and damage are recorded by hand on the product.
//
// Selling more than is on hand is allowed (the balance goes below zero and shows as such):
// the sale happened, and blocking the invoice would only push people to skip the system.
import { z } from "zod";
import { Prisma, type StockMovementKind } from "../../generated/prisma/client.js";
import { businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, type DecimalLike } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

type Tx = Prisma.TransactionClient;
type Actor = { id: string; companyId: string };

/** Quantities of stock: up to 3 decimals (kilos, metres), as strings for Decimal. */
export const quantityString = (q: DecimalLike) => new Decimal(q).toDecimalPlaces(3).toFixed(3);
/** For the API: a plain number (3 decimals at most), null for services. */
export const stockNumber = (q: Prisma.Decimal | null) => (q === null ? null : Number(q.toDecimalPlaces(3)));

type Meta = {
  kind: StockMovementKind;
  /** yyyy-mm-dd */
  date: string;
  userId: string | null;
  invoiceId?: string;
  creditNoteId?: string;
  note?: string | null;
};

/**
 * Moves stock for the catalog products among `lines` (+ in, - out per `sign`); lines with no
 * product, and services, are skipped. One movement per product (quantities on several lines of
 * the same product are added up). Products are updated in id order, so two transactions moving
 * the same products never wait on each other in a circle.
 */
export async function moveStock(
  tx: Tx,
  companyId: string,
  lines: { productId?: string | null | undefined; quantity: DecimalLike }[],
  sign: 1 | -1,
  meta: Meta,
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
  for (const { id } of tracked) {
    const delta = totals.get(id)!.times(sign);
    if (delta.isZero()) continue;
    await apply(tx, companyId, id, delta, meta);
  }
}

/** One product's stock changes by `delta`; logged with the balance after it. */
async function apply(tx: Tx, companyId: string, productId: string, delta: Prisma.Decimal, meta: Meta) {
  const { stock } = await tx.product.update({
    where: { id: productId },
    data: { stock: { increment: delta } },
    select: { stock: true },
  });
  return tx.stockMovement.create({
    data: {
      kind: meta.kind,
      date: toDate(meta.date),
      quantity: delta,
      balance: stock ?? delta,
      note: meta.note ?? null,
      createdById: meta.userId,
      companyId,
      productId,
      invoiceId: meta.invoiceId ?? null,
      creditNoteId: meta.creditNoteId ?? null,
    },
    select: { id: true },
  });
}

/**
 * Puts back what an earlier set of movements took out (or takes back what it put in): the
 * invoice's sales when it's cancelled, a credit note's returns when it's deleted. Uses the
 * movements themselves, so an invoice issued before stock was tracked moves nothing.
 */
export async function reverseMovements(
  tx: Tx,
  companyId: string,
  where: { invoiceId: string; kind: "sale" } | { creditNoteId: string; kind: "returned" },
  meta: Omit<Meta, "invoiceId" | "creditNoteId">,
) {
  const rows = await tx.stockMovement.findMany({
    where: { companyId, ...where },
    select: { productId: true, quantity: true },
  });
  const lines = rows.map((r) => ({ productId: r.productId, quantity: r.quantity.negated() }));
  await moveStock(tx, companyId, lines, 1, {
    ...meta,
    ...("invoiceId" in where ? { invoiceId: where.invoiceId } : { creditNoteId: where.creditNoteId }),
  });
}

/** An invoice's lines, for its stock to go out when it is issued. */
export const linesOf = (tx: Tx, invoiceId: string) =>
  tx.invoiceLine.findMany({ where: { invoiceId }, select: { productId: true, quantity: true } });

// ---------------------------------------------------------------------------
// By hand: goods received, a count, damage
// ---------------------------------------------------------------------------

const quantity = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Must be a non-negative number with up to 3 decimals"),
);

export const adjustStockSchema = z.object({
  /** received: + quantity; damaged: - quantity; counted: quantity is what was counted on hand. */
  kind: z.enum(["received", "counted", "damaged"]),
  quantity,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || undefined),
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
    } else {
      await apply(tx, actor.companyId, productId, delta, { kind: input.kind, date, userId: actor.id, note: input.note ?? null });
    }
    await audit(tx, actor.companyId, {
      action: "update",
      event: "stockAdjusted",
      item: { type: "product", id: productId, ref: product.name },
      values: { kind: input.kind, quantity: quantityString(delta), from: quantityString(before), to: quantityString(before.plus(delta)) },
    });
  });
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
        note: true,
        createdAt: true,
        createdById: true,
        invoice: { select: { number: true, numberPrefix: true, customerName: true } },
        creditNote: { select: { number: true, invoice: { select: { number: true, numberPrefix: true, customerName: true } } } },
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
        note: r.note,
        at: r.createdAt.toISOString(),
        by: r.createdById ? (users.get(r.createdById) ?? null) : null,
        // Where it came from: the invoice (its number for the link), or the credit note on one.
        invoice: invoice ? { number: invoice.number, displayNumber: `${invoice.numberPrefix}${invoice.number}`, customer: invoice.customerName } : null,
        creditNote: r.creditNote ? `CN-${String(r.creditNote.number).padStart(4, "0")}` : null,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
