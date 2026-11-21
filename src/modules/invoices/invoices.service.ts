import { Prisma, type InvoiceStatus } from "../../generated/prisma/client.js";
import { generateToken } from "../../lib/crypto.js";
import { addDays, businessToday, daysBetween, monthRange, toDate, toIso, yearRange } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, invoiceTotals, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { checkBooksOpen, lockBooks } from "../ledger/ledger.periods.js";
import { markQuoteConverted } from "../quotes/quote-conversion.js";
import type { CreateInvoiceInput, ListInvoicesQuery, RecordPaymentInput, ReminderInput } from "./invoices.schemas.js";

/** Egypt's standard VAT rate, used when VAT is on in the company settings. */
export const VAT_RATE = 14;
const EXPORT_LIMIT = 5000;

type Actor = { id: string; companyId: string };
type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Status: "overdue" is worked out from the due date, never stored
// ---------------------------------------------------------------------------

const OPEN: InvoiceStatus[] = ["sent", "partial"];

/** Sent or partly paid, and the due date is before today (Cairo). */
export const overdueWhere = (today = businessToday()): Prisma.InvoiceWhereInput => ({
  status: { in: OPEN },
  dueDate: { lt: toDate(today) },
});

function statusWhere(status: ListInvoicesQuery["status"], today: string): Prisma.InvoiceWhereInput {
  switch (status) {
    case "all":
      return {};
    case "overdue":
      return overdueWhere(today);
    // The "sent" and "partial" tabs exclude invoices that are already overdue.
    case "sent":
    case "partial":
      return { status, dueDate: { gte: toDate(today) } };
    default:
      return { status };
  }
}

function displayStatus(row: { status: InvoiceStatus; dueDate: Date }, today: string) {
  const due = toIso(row.dueDate);
  if (OPEN.includes(row.status) && due < today) {
    return { status: "overdue" as const, daysOverdue: daysBetween(due, today) };
  }
  return { status: row.status, daysOverdue: null };
}

/** What is still owed: nothing on a cancelled invoice, the full total on a draft. */
function remainingOf(row: { status: InvoiceStatus; total: Prisma.Decimal; amountPaid: Prisma.Decimal }) {
  return row.status === "cancelled" ? ZERO : row.total.minus(row.amountPaid);
}

// ---------------------------------------------------------------------------
// Shapes sent to the frontend (money as 2-decimal strings, dates as yyyy-mm-dd)
// ---------------------------------------------------------------------------

const listSelect = {
  id: true,
  number: true,
  numberPrefix: true,
  status: true,
  issueDate: true,
  dueDate: true,
  customerId: true,
  customerName: true,
  total: true,
  amountPaid: true,
} satisfies Prisma.InvoiceSelect;

type ListRow = Prisma.InvoiceGetPayload<{ select: typeof listSelect }>;

function toListDto(row: ListRow, today: string) {
  return {
    id: row.id,
    number: row.number,
    displayNumber: `${row.numberPrefix}${row.number}`,
    customerId: row.customerId,
    customer: row.customerName,
    issueDate: toIso(row.issueDate),
    dueDate: toIso(row.dueDate),
    total: moneyString(row.total),
    remaining: moneyString(remainingOf(row)),
    ...displayStatus(row, today),
  };
}

const detailSelect = {
  ...listSelect,
  paymentTermsDays: true,
  customerTaxNumber: true,
  customerEmail: true,
  customerPhone: true,
  customerCity: true,
  subtotal: true,
  vatRate: true,
  vat: true,
  notes: true,
  publicToken: true,
  sentAt: true,
  cancelledAt: true,
  createdAt: true,
  lines: {
    orderBy: { position: "asc" },
    select: { id: true, description: true, quantity: true, unitPrice: true, amount: true, productId: true },
  },
  payments: {
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      number: true,
      amount: true,
      date: true,
      method: true,
      status: true,
      account: true,
      reference: true,
      note: true,
    },
  },
  events: {
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, values: true, createdAt: true },
  },
  company: {
    select: {
      name: true,
      taxNumber: true,
      commercialRegister: true,
      address: true,
      phone: true,
      currency: true,
      invoiceTemplate: true,
      invoiceFooter: true,
    },
  },
  recurring: { select: { id: true, name: true } },
} satisfies Prisma.InvoiceSelect;

type DetailRow = Prisma.InvoiceGetPayload<{ select: typeof detailSelect }>;

function toDetailDto(row: DetailRow, today: string, { publicView = false } = {}) {
  return {
    ...toListDto(row, today),
    terms: row.paymentTermsDays,
    currency: row.company.currency,
    template: row.company.invoiceTemplate,
    footer: row.company.invoiceFooter,
    issuer: {
      name: row.company.name,
      taxNumber: row.company.taxNumber,
      commercialRegister: row.company.commercialRegister,
      location: row.company.address,
      phone: row.company.phone,
    },
    client: {
      name: row.customerName,
      taxNumber: row.customerTaxNumber,
      location: row.customerCity,
      email: row.customerEmail,
      phone: row.customerPhone,
    },
    lines: row.lines.map((line) => ({
      id: line.id,
      title: line.description,
      quantity: line.quantity.toString(),
      unitPrice: moneyString(line.unitPrice),
      amount: moneyString(line.amount),
      productId: line.productId,
    })),
    subtotal: moneyString(row.subtotal),
    vatRate: row.vatRate.toFixed(2),
    vat: moneyString(row.vat),
    // Kept for the existing invoice layout; totals are exact, so it is always 0.
    rounding: "0.00",
    note: row.notes,
    payments: row.payments.map((p) => ({
      id: p.id,
      amount: moneyString(p.amount),
      date: toIso(p.date),
      method: p.method,
      number: paymentNumber(p.number),
      status: p.status,
      account: p.account,
      reference: p.reference,
      note: p.note,
    })),
    sentAt: row.sentAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    // Internal details stay off the public page.
    ...(publicView
      ? {}
      : {
          publicToken: row.publicToken,
          // The recurring template that made it, if any.
          recurring: row.recurring,
          history: row.events.map((e) => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), values: e.values })),
        }),
  };
}

export type InvoiceListDto = ReturnType<typeof toListDto>;
export type InvoiceDetailDto = ReturnType<typeof toDetailDto>;

// ---------------------------------------------------------------------------
// Finding an invoice: by id (uuid) or by its number (/invoices/1044)
// ---------------------------------------------------------------------------

export type InvoiceRef = { id: string } | { number: number };

export function parseInvoiceRef(value: unknown): InvoiceRef {
  const ref = String(value ?? "");
  if (/^\d{1,9}$/.test(ref)) return { number: Number(ref) };
  if (/^[0-9a-f-]{36}$/i.test(ref)) return { id: ref };
  throw notFound("Invoice");
}

async function findRow<T extends Prisma.InvoiceSelect>(db: Tx, companyId: string, ref: InvoiceRef, select: T) {
  const row = await db.invoice.findFirst({ where: { companyId, ...ref }, select });
  if (!row) throw notFound("Invoice");
  return row as Prisma.InvoiceGetPayload<{ select: T }>;
}

export async function getInvoice(companyId: string, ref: InvoiceRef) {
  return toDetailDto(await findRow(prisma, companyId, ref, detailSelect), businessToday());
}

/** The public page behind the invoice link: no login, found by its secret token. */
export async function getPublicInvoice(token: string) {
  const row = await prisma.invoice.findFirst({
    where: { publicToken: token, status: { not: "draft" } },
    select: detailSelect,
  });
  if (!row) throw notFound("Invoice");
  return toDetailDto(row, businessToday(), { publicView: true });
}

// ---------------------------------------------------------------------------
// List, stats, export
// ---------------------------------------------------------------------------

function buildWhere(companyId: string, query: ListInvoicesQuery, today: string) {
  const and: Prisma.InvoiceWhereInput[] = [{ companyId }, statusWhere(query.status, today)];

  if (query.customerId) and.push({ customerId: query.customerId });

  const range =
    query.period === "thisMonth"
      ? monthRange(today)
      : query.period === "lastMonth"
        ? monthRange(today, -1)
        : query.period === "thisYear"
          ? yearRange(today)
          : null;
  if (range) and.push({ issueDate: { gte: toDate(range.start), lte: toDate(range.end) } });

  if (query.q) {
    const nameMatch: Prisma.InvoiceWhereInput = { customerName: { contains: query.q, mode: "insensitive" } };
    // "#1044", "1044" or "INV-1044" also find invoice 1044.
    const number = query.q.match(/^[A-Za-z-]*#?(\d{1,9})$/)?.[1];
    and.push(number ? { OR: [{ number: Number(number) }, nameMatch] } : nameMatch);
  }

  return { AND: and } satisfies Prisma.InvoiceWhereInput;
}

const ORDER_BY: Record<ListInvoicesQuery["sort"], Prisma.InvoiceOrderByWithRelationInput[]> = {
  recent: [{ number: "desc" }],
  oldest: [{ number: "asc" }],
  amount: [{ total: "desc" }, { number: "desc" }],
  due: [{ dueDate: "asc" }, { number: "asc" }],
};

export async function listInvoices(companyId: string, query: ListInvoicesQuery) {
  const today = businessToday();
  const where = buildWhere(companyId, query, today);
  const count = (status: ListInvoicesQuery["status"]) =>
    prisma.invoice.count({ where: { companyId, ...statusWhere(status, today) } });

  const [rows, total, ...counts] = await prisma.$transaction([
    prisma.invoice.findMany({
      where,
      select: listSelect,
      orderBy: ORDER_BY[query.sort],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.invoice.count({ where }),
    // Tab counts: the whole company, regardless of the other filters.
    count("all"),
    count("draft"),
    count("sent"),
    count("partial"),
    count("paid"),
    count("overdue"),
    count("cancelled"),
  ]);
  const [all, draft, sent, partial, paid, overdue, cancelled] = counts;

  return {
    items: rows.map((row) => toListDto(row, today)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts: { all, draft, sent, partial, paid, overdue, cancelled },
  };
}

export async function exportInvoices(companyId: string, query: ListInvoicesQuery) {
  const today = businessToday();
  const rows = await prisma.invoice.findMany({
    where: buildWhere(companyId, query, today),
    select: listSelect,
    orderBy: ORDER_BY[query.sort],
    take: EXPORT_LIMIT,
  });
  return rows.map((row) => toListDto(row, today));
}

/** The numbers on top of the invoices page. */
export async function invoiceStats(companyId: string) {
  const today = businessToday();
  const thisMonth = monthRange(today);
  const lastMonth = monthRange(today, -1);
  const collected = (range: { start: string; end: string }) =>
    prisma.invoicePayment.aggregate({
      // A cheque counts as collected only once it has cleared.
      where: { companyId, status: "cleared", date: { gte: toDate(range.start), lte: toDate(range.end) } },
      _sum: { amount: true },
    });

  const [open, overdue, drafts, collectedNow, collectedBefore] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId, status: { in: OPEN } },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.invoice.aggregate({
      where: { companyId, ...overdueWhere(today) },
      _sum: { total: true, amountPaid: true },
      _count: true,
    }),
    prisma.invoice.aggregate({ where: { companyId, status: "draft" }, _sum: { total: true }, _count: true }),
    collected(thisMonth),
    collected(lastMonth),
  ]);

  const owed = (agg: { _sum: { total: Prisma.Decimal | null; amountPaid: Prisma.Decimal | null } }) =>
    (agg._sum.total ?? ZERO).minus(agg._sum.amountPaid ?? ZERO);
  const now = collectedNow._sum.amount ?? ZERO;
  const before = collectedBefore._sum.amount ?? ZERO;

  return {
    outstanding: moneyString(owed(open)),
    unpaidCount: open._count,
    overdue: moneyString(owed(overdue)),
    overdueCount: overdue._count,
    collectedThisMonth: moneyString(now),
    // null when there was nothing to compare with last month.
    collectedChangePct: before.isZero() ? null : now.minus(before).dividedBy(before).times(100).round().toNumber(),
    draftsCount: drafts._count,
    draftsValue: moneyString(drafts._sum.total ?? ZERO),
  };
}

/** Totals for a customer's page: invoices that count (not drafts, not cancelled). */
export async function customerInvoiceSummary(companyId: string, customerId: string) {
  const agg = await prisma.invoice.aggregate({
    where: { companyId, customerId, status: { notIn: ["draft", "cancelled"] } },
    _sum: { total: true, amountPaid: true },
    _count: true,
  });
  return {
    billableCount: agg._count,
    totalInvoiced: moneyString(agg._sum.total ?? ZERO),
    collected: moneyString(agg._sum.amountPaid ?? ZERO),
  };
}

// ---------------------------------------------------------------------------
// Create and send
// ---------------------------------------------------------------------------

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

async function actorName(userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }))?.fullName ?? "";
}

/** Adds to (or takes from) what a customer owes, and counts as activity. */
function moveCustomerBalance(db: Tx, customerId: string, delta: Prisma.Decimal) {
  return db.customer.update({
    where: { id: customerId },
    data: { balance: { increment: delta }, lastActivityAt: new Date() },
  });
}

/** Set when a recurring template makes the invoice: which template, for which scheduled date. */
export type InvoiceOrigin = { recurringId: string; runDate: string };

export async function createInvoice(actor: Actor, input: CreateInvoiceInput, origin?: InvoiceOrigin) {
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, companyId: actor.companyId },
    select: { id: true, name: true, taxNumber: true, email: true, phone: true, city: true },
  });
  if (!customer) throw new AppError(400, "INVALID_CUSTOMER", "Choose a customer of this company", { field: "customerId" });

  const productIds = [...new Set(input.items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  if (productIds.length > 0) {
    const found = await prisma.product.count({ where: { id: { in: productIds }, companyId: actor.companyId } });
    if (found !== productIds.length) throw new AppError(400, "INVALID_PRODUCT", "An item is not in this company's catalog");
  }

  // An issued invoice can't be dated in the future (a draft may be, until it is sent).
  if (input.send && input.issueDate > businessToday()) throw futureIssueDate(400);

  const name = await actorName(actor.id);

  try {
    const id = await prisma.$transaction(async (tx) => {
      // Taking the number: the update locks the company row until this transaction
      // ends, so two invoices created at the same moment never get the same number.
      const company = await tx.company.update({
        where: { id: actor.companyId },
        data: { invoiceNextNumber: { increment: 1 } },
        select: { invoiceNextNumber: true, invoicePrefix: true, vatEnabled: true, booksClosedThrough: true },
      });
      // An issued invoice goes into the books on its date, which must be open (a draft doesn't, yet).
      if (input.send) checkBooksOpen(company.booksClosedThrough, [input.issueDate]);
      const vatRate = company.vatEnabled ? VAT_RATE : 0;
      const { amounts, subtotal, vat, total } = invoiceTotals(input.items, vatRate);
      const now = Date.now();
      const number = company.invoiceNextNumber - 1;

      const invoice = await tx.invoice.create({
        data: {
          number,
          numberPrefix: company.invoicePrefix,
          status: input.send ? "sent" : "draft",
          issueDate: toDate(input.issueDate),
          dueDate: toDate(addDays(input.issueDate, input.terms)),
          paymentTermsDays: input.terms,
          customerName: customer.name,
          customerTaxNumber: customer.taxNumber,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          customerCity: customer.city,
          subtotal,
          vatRate,
          vat,
          total,
          notes: input.notes ?? null,
          publicToken: input.send ? generateToken() : null,
          sentAt: input.send ? new Date(now) : null,
          companyId: actor.companyId,
          customerId: customer.id,
          createdById: actor.id,
          recurringId: origin?.recurringId ?? null,
          recurringRunDate: origin ? toDate(origin.runDate) : null,
          lines: {
            create: input.items.map((item, position) => ({
              position,
              description: item.description,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              amount: amounts[position]!,
              productId: item.productId ?? null,
            })),
          },
          events: {
            create: [
              { type: "created", values: { name }, userId: actor.id, createdAt: new Date(now) },
              ...(input.send
                ? [{ type: "sent" as const, values: {}, userId: actor.id, createdAt: new Date(now + 1) }]
                : []),
            ],
          },
        },
        select: { id: true },
      });

      // Made from an accepted quote: mark it converted, or fail and roll this invoice back.
      if (input.fromQuote !== undefined) {
        await markQuoteConverted(tx, actor, input.fromQuote, {
          id: invoice.id,
          number,
          displayNumber: `${company.invoicePrefix}${number}`,
          customerId: customer.id,
        });
      }

      // A draft owes nothing yet; a sent invoice adds its total to the customer's balance.
      await moveCustomerBalance(tx, customer.id, input.send ? total : ZERO);
      return invoice.id;
    });
    return getInvoice(actor.companyId, { id });
  } catch (err) {
    // Only possible if the "next number" in the settings was set to a used one.
    if (isUniqueViolation(err)) {
      throw new AppError(409, "INVOICE_NUMBER_USED", "The next invoice number is already used; change it in the settings");
    }
    throw err;
  }
}

const futureIssueDate = (status: 400 | 409) =>
  new AppError(status, "FUTURE_ISSUE_DATE", "An invoice can't be issued with a date after today", { field: "issueDate" });

/** Issues a draft: it gets its public link and starts counting in the customer's balance. */
export async function sendInvoice(actor: Actor, ref: InvoiceRef) {
  await prisma.$transaction(async (tx) => {
    const closedThrough = await lockBooks(tx, actor.companyId);
    const row = await findRow(tx, actor.companyId, ref, { id: true, status: true, total: true, customerId: true, issueDate: true });
    if (row.status === "draft" && toIso(row.issueDate) > businessToday()) throw futureIssueDate(409);
    if (row.status === "draft") checkBooksOpen(closedThrough, [toIso(row.issueDate)]);
    // The status condition makes this safe if two people press "send" at once.
    const { count } = await tx.invoice.updateMany({
      where: { id: row.id, status: "draft" },
      data: { status: "sent", sentAt: new Date(), publicToken: generateToken() },
    });
    if (count === 0) throw new AppError(409, "INVOICE_NOT_DRAFT", "Only a draft can be sent");
    await tx.invoiceEvent.create({ data: { invoiceId: row.id, type: "sent", userId: actor.id } });
    await moveCustomerBalance(tx, row.customerId, row.total);
  });
  return getInvoice(actor.companyId, ref);
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/** Receipt number as shown: PAY-0001. */
export const paymentNumber = (n: number) => `PAY-${String(n).padStart(4, "0")}`;

export async function recordPayment(actor: Actor, ref: InvoiceRef, input: RecordPaymentInput) {
  await applyPayment(actor, ref, input);
  return getInvoice(actor.companyId, ref);
}

/**
 * Records a payment on an invoice and returns the new payment's id.
 * Also used by the payments page (POST /api/payments).
 */
export async function applyPayment(actor: Actor, ref: InvoiceRef, input: RecordPaymentInput) {
  const amount = money(input.amount);
  const today = businessToday();

  return prisma.$transaction(async (tx) => {
    // Receipt number, taken the same way as invoice numbers (the update locks the
    // company row first: same lock order as everywhere else, and the closing date
    // read here can't change before this payment is saved).
    const company = await tx.company.update({
      where: { id: actor.companyId },
      data: { paymentNextNumber: { increment: 1 } },
      select: { paymentNextNumber: true, booksClosedThrough: true },
    });
    const row = await findRow(tx, actor.companyId, ref, {
      id: true,
      status: true,
      issueDate: true,
      customerId: true,
    });
    if (!OPEN.includes(row.status)) {
      throw new AppError(409, "INVOICE_NOT_PAYABLE", "Payments can only be recorded on a sent, unpaid invoice");
    }
    if (input.date > today) {
      throw new AppError(400, "PAYMENT_DATE_IN_FUTURE", "The payment date can't be in the future", { field: "date" });
    }
    if (input.date < toIso(row.issueDate)) {
      throw new AppError(400, "PAYMENT_BEFORE_ISSUE", "The payment date can't be before the invoice date", { field: "date" });
    }
    checkBooksOpen(company.booksClosedThrough, [input.date]);

    // One statement adds the payment only if it fits in what is still owed.
    // Two payments recorded at the same moment can't together pay more than the total.
    const updated = await tx.$executeRaw`
      UPDATE "invoices"
      SET "amountPaid" = "amountPaid" + ${amount}::numeric,
          "status" = (CASE WHEN "amountPaid" + ${amount}::numeric = "total" THEN 'paid' ELSE 'partial' END)::"InvoiceStatus",
          "updatedAt" = now()
      WHERE "id" = ${row.id}
        AND "status" IN ('sent', 'partial')
        AND "amountPaid" + ${amount}::numeric <= "total"`;
    if (updated === 0) {
      throw new AppError(400, "PAYMENT_EXCEEDS_BALANCE", "The payment is more than what is still owed", { field: "amount" });
    }

    // A cheque lowers what is owed straight away but only counts as collected once it clears.
    const pending = input.method === "cheque";

    const payment = await tx.invoicePayment.create({
      data: {
        number: company.paymentNextNumber - 1,
        invoiceId: row.id,
        companyId: actor.companyId,
        amount,
        date: toDate(input.date),
        method: input.method,
        status: pending ? "pending" : "cleared",
        clearedAt: pending ? null : new Date(),
        account: input.account ?? null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdById: actor.id,
      },
      select: { id: true, number: true },
    });
    await tx.invoiceEvent.create({
      data: {
        invoiceId: row.id,
        type: "payment",
        values: { amount: moneyString(amount), payment: paymentNumber(payment.number) },
        userId: actor.id,
      },
    });
    await moveCustomerBalance(tx, row.customerId, amount.negated());
    return payment.id;
  });
}

// ---------------------------------------------------------------------------
// Cancel and remind
// ---------------------------------------------------------------------------

const notCancellable = () =>
  new AppError(
    409,
    "INVOICE_NOT_CANCELLABLE",
    "Only a draft or a sent invoice with no payments can be cancelled",
  );

/**
 * Cancels a draft, or a sent invoice nobody has paid anything on. An invoice
 * with payments needs a credit note instead (not built yet).
 */
export async function cancelInvoice(actor: Actor, ref: InvoiceRef) {
  await prisma.$transaction(async (tx) => {
    const closedThrough = await lockBooks(tx, actor.companyId);
    const row = await findRow(tx, actor.companyId, ref, {
      id: true,
      status: true,
      total: true,
      amountPaid: true,
      customerId: true,
      issueDate: true,
    });
    if ((row.status !== "draft" && row.status !== "sent") || !row.amountPaid.isZero()) throw notCancellable();
    if (row.status === "sent") checkBooksOpen(closedThrough, [toIso(row.issueDate)]);

    // Same status and still nothing paid, checked in the update itself.
    const { count } = await tx.invoice.updateMany({
      where: { id: row.id, status: row.status, amountPaid: 0 },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    if (count === 0) throw notCancellable();

    await tx.invoiceEvent.create({ data: { invoiceId: row.id, type: "cancelled", userId: actor.id } });
    // A sent invoice was counted in the customer's balance; a draft never was.
    if (row.status === "sent") await moveCustomerBalance(tx, row.customerId, row.total.negated());
  });
  return getInvoice(actor.companyId, ref);
}

/** Cancels every invoice that can be cancelled; the rest are skipped. */
export async function bulkCancel(actor: Actor, ids: string[]) {
  let cancelled = 0;
  for (const id of new Set(ids)) {
    try {
      await cancelInvoice(actor, { id });
      cancelled += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  return { cancelled, skipped: new Set(ids).size - cancelled };
}

/**
 * Records that a reminder was sent. Nothing is actually delivered yet: email and
 * WhatsApp sending come later.
 */
export async function recordReminder(actor: Actor, ref: InvoiceRef, input: ReminderInput) {
  const row = await findRow(prisma, actor.companyId, ref, { id: true, status: true });
  if (!OPEN.includes(row.status)) {
    throw new AppError(409, "INVOICE_NOT_REMINDABLE", "Reminders are only for sent invoices that aren't fully paid");
  }
  await prisma.invoiceEvent.create({
    data: { invoiceId: row.id, type: "reminderSent", values: { channel: input.channel }, userId: actor.id },
  });
  return getInvoice(actor.companyId, ref);
}

export { Decimal };
