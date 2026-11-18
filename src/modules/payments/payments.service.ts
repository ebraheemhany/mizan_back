import type { Prisma } from "../../generated/prisma/client.js";
import { businessToday, daysBetween, monthRange, toDate, toIso, yearRange } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { applyPayment, overdueWhere, paymentNumber } from "../invoices/invoices.service.js";
import type { CreatePaymentInput, ListPaymentsQuery } from "./payments.schemas.js";

type Actor = { id: string; companyId: string };
const EXPORT_LIMIT = 5000;

const paymentSelect = {
  id: true,
  number: true,
  amount: true,
  date: true,
  method: true,
  status: true,
  account: true,
  reference: true,
  note: true,
  clearedAt: true,
  createdAt: true,
  invoice: {
    select: { id: true, number: true, numberPrefix: true, customerId: true, customerName: true, issueDate: true },
  },
} satisfies Prisma.InvoicePaymentSelect;

type PaymentRow = Prisma.InvoicePaymentGetPayload<{ select: typeof paymentSelect }>;

function toDto(row: PaymentRow) {
  return {
    id: row.id,
    number: paymentNumber(row.number),
    invoiceId: row.invoice.id,
    invoiceNumber: row.invoice.number,
    invoiceDisplayNumber: `${row.invoice.numberPrefix}${row.invoice.number}`,
    customerId: row.invoice.customerId,
    customer: row.invoice.customerName,
    date: toIso(row.date),
    invoiceDate: toIso(row.invoice.issueDate),
    method: row.method,
    amount: moneyString(row.amount),
    status: row.status,
    account: row.account,
    reference: row.reference,
    note: row.note,
    clearedAt: row.clearedAt,
    createdAt: row.createdAt,
  };
}

export type PaymentDto = ReturnType<typeof toDto>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function buildWhere(companyId: string, query: Omit<ListPaymentsQuery, "page" | "pageSize">) {
  const today = businessToday();
  const and: Prisma.InvoicePaymentWhereInput[] = [{ companyId }];

  if (query.method !== "all") and.push({ method: query.method });

  const range =
    query.period === "thisMonth"
      ? monthRange(today)
      : query.period === "lastMonth"
        ? monthRange(today, -1)
        : query.period === "thisYear"
          ? yearRange(today)
          : null;
  if (range) and.push({ date: { gte: toDate(range.start), lte: toDate(range.end) } });

  if (query.q) {
    const or: Prisma.InvoicePaymentWhereInput[] = [
      { invoice: { customerName: { contains: query.q, mode: "insensitive" } } },
    ];
    // "PAY-0012" or "12" finds payment 12; "#1044" or "INV-1044" finds the payments of invoice 1044.
    const payment = query.q.match(/^(?:PAY-?)?0*(\d{1,9})$/i)?.[1];
    if (payment) or.push({ number: Number(payment) });
    const invoice = query.q.match(/^[A-Za-z-]*#?(\d{1,9})$/)?.[1];
    if (invoice) or.push({ invoice: { number: Number(invoice) } });
    and.push({ OR: or });
  }

  return { AND: and } satisfies Prisma.InvoicePaymentWhereInput;
}

const ORDER_BY: Prisma.InvoicePaymentOrderByWithRelationInput[] = [{ date: "desc" }, { number: "desc" }];

export async function listPayments(companyId: string, query: ListPaymentsQuery) {
  const where = buildWhere(companyId, query);
  const [rows, total, all] = await prisma.$transaction([
    prisma.invoicePayment.findMany({
      where,
      select: paymentSelect,
      orderBy: ORDER_BY,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.invoicePayment.count({ where }),
    prisma.invoicePayment.count({ where: { companyId } }),
  ]);
  return { items: rows.map(toDto), total, all, page: query.page, pageSize: query.pageSize };
}

export async function exportPayments(companyId: string, query: ListPaymentsQuery) {
  const rows = await prisma.invoicePayment.findMany({
    where: buildWhere(companyId, query),
    select: paymentSelect,
    orderBy: ORDER_BY,
    take: EXPORT_LIMIT,
  });
  return rows.map(toDto);
}

async function getPayment(companyId: string, id: string) {
  const row = await prisma.invoicePayment.findFirst({ where: { id, companyId }, select: paymentSelect });
  if (!row) throw notFound("Payment");
  return toDto(row);
}

/** Average days from invoice date to payment, over cleared payments in a month (null if none). */
async function averageDaysToCollect(companyId: string, range: { start: string; end: string }) {
  const [row] = await prisma.$queryRaw<{ avg: number | null }[]>`
    SELECT AVG(p."date" - i."issueDate")::float AS avg
    FROM "invoice_payments" p
    JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId}
      AND p."status" = 'cleared'
      AND p."date" BETWEEN ${toDate(range.start)}::date AND ${toDate(range.end)}::date`;
  return row?.avg === null || row?.avg === undefined ? null : Math.round(row.avg);
}

/** The cards on top of the payments page. */
export async function paymentStats(companyId: string) {
  const today = businessToday();
  const thisMonth = monthRange(today);
  const lastMonth = monthRange(today, -1);
  const collected = (range: { start: string; end: string }) =>
    prisma.invoicePayment.aggregate({
      where: { companyId, status: "cleared", date: { gte: toDate(range.start), lte: toDate(range.end) } },
      _sum: { amount: true },
    });

  const [now, before, open, cheques, daysNow, daysBefore] = await Promise.all([
    collected(thisMonth),
    collected(lastMonth),
    prisma.invoice.aggregate({
      where: { companyId, status: { in: ["sent", "partial"] } },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.invoicePayment.aggregate({
      where: { companyId, method: "cheque", status: "pending" },
      _sum: { amount: true },
      _count: true,
    }),
    averageDaysToCollect(companyId, thisMonth),
    averageDaysToCollect(companyId, lastMonth),
  ]);

  const nowSum = now._sum.amount ?? ZERO;
  const beforeSum = before._sum.amount ?? ZERO;

  return {
    collectedThisMonth: moneyString(nowSum),
    // null when there was nothing to compare with last month.
    collectedChangePct: beforeSum.isZero() ? null : nowSum.minus(beforeSum).dividedBy(beforeSum).times(100).round().toNumber(),
    awaiting: moneyString((open._sum.total ?? ZERO).minus(open._sum.amountPaid ?? ZERO)),
    awaitingCount: open._count,
    pendingCheques: moneyString(cheques._sum.amount ?? ZERO),
    pendingChequesCount: cheques._count,
    avgDaysToCollect: daysNow,
    avgDaysToCollectLastMonth: daysBefore,
  };
}

/**
 * Invoices that still have something to pay, for the "record a payment" form
 * and the collection reminders (soonest due first).
 */
export async function openInvoices(companyId: string) {
  const today = businessToday();
  const rows = await prisma.invoice.findMany({
    where: { companyId, status: { in: ["sent", "partial"] } },
    select: {
      id: true,
      number: true,
      numberPrefix: true,
      customerId: true,
      customerName: true,
      customerPhone: true,
      issueDate: true,
      dueDate: true,
      total: true,
      amountPaid: true,
    },
    orderBy: [{ dueDate: "asc" }, { number: "asc" }],
    take: 300,
  });
  const overdueIds = new Set(
    (
      await prisma.invoice.findMany({
        where: { companyId, ...overdueWhere(today) },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  return rows.map((r) => {
    const due = toIso(r.dueDate);
    return {
      id: r.id,
      number: r.number,
      displayNumber: `${r.numberPrefix}${r.number}`,
      customerId: r.customerId,
      customer: r.customerName,
      customerPhone: r.customerPhone,
      balance: moneyString(r.total.minus(r.amountPaid)),
      issueDate: toIso(r.issueDate),
      dueDate: due,
      daysOverdue: overdueIds.has(r.id) ? daysBetween(due, today) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createPayment(actor: Actor, input: CreatePaymentInput) {
  const { invoiceId, ...payment } = input;
  const id = await applyPayment(actor, { id: invoiceId }, payment);
  return getPayment(actor.companyId, id);
}

/** A pending cheque has cleared: from now on it counts as collected. */
export async function clearPayment(actor: Actor, id: string) {
  const { count } = await prisma.invoicePayment.updateMany({
    where: { id, companyId: actor.companyId, status: "pending" },
    data: { status: "cleared", clearedAt: new Date() },
  });
  if (count === 0) {
    await getPayment(actor.companyId, id); // 404 if it isn't ours
    throw new AppError(409, "PAYMENT_NOT_PENDING", "Only a pending cheque can be marked as cleared");
  }
  return getPayment(actor.companyId, id);
}

/**
 * Removes a payment (recorded by mistake, or a cheque that bounced): the amount
 * goes back onto the invoice and the customer's balance, and the invoice's
 * history keeps a note of it.
 */
export async function removePayment(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.invoicePayment.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true, number: true, amount: true, invoiceId: true, invoice: { select: { customerId: true } } },
    });
    if (!payment) throw notFound("Payment");

    // Take the amount back off the invoice in one statement, recomputing its status.
    const updated = await tx.$executeRaw`
      UPDATE "invoices"
      SET "amountPaid" = "amountPaid" - ${payment.amount}::numeric,
          "status" = (CASE WHEN "amountPaid" - ${payment.amount}::numeric = 0 THEN 'sent' ELSE 'partial' END)::"InvoiceStatus",
          "updatedAt" = now()
      WHERE "id" = ${payment.invoiceId}
        AND "status" IN ('partial', 'paid')
        AND "amountPaid" >= ${payment.amount}::numeric`;
    if (updated === 0) throw new AppError(409, "PAYMENT_NOT_REMOVABLE", "This payment can't be removed");

    await tx.invoicePayment.delete({ where: { id: payment.id } });
    await tx.invoiceEvent.create({
      data: {
        invoiceId: payment.invoiceId,
        type: "paymentRemoved",
        values: { amount: moneyString(payment.amount), payment: paymentNumber(payment.number) },
        userId: actor.id,
      },
    });
    await tx.customer.update({
      where: { id: payment.invoice.customerId },
      data: { balance: { increment: payment.amount }, lastActivityAt: new Date() },
    });
  });
}
