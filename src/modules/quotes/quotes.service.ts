import { Prisma, type QuoteStatus, type Role } from "../../generated/prisma/client.js";
import { generateToken } from "../../lib/crypto.js";
import {
  addDays,
  BUSINESS_TIME_ZONE,
  businessToday,
  daysBetween,
  monthRange,
  toDate,
  toIso,
  yearRange,
} from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, invoiceTotals, moneyString, ZERO, type LineInput } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { can } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { VAT_RATE } from "../invoices/invoices.service.js";
import type { CreateQuoteInput, ListQuotesQuery, QuoteListStatus, UpdateQuoteInput } from "./quotes.schemas.js";

type Actor = { id: string; companyId: string; role: Role };
type Tx = Prisma.TransactionClient;

/** How far ahead "expiring soon" looks on the stats cards. */
export const EXPIRING_WITHIN_DAYS = 7;
/** The acceptance rate looks at quotes issued in this many days, today included. */
export const ACCEPTANCE_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Status: "expired" is worked out from validUntil, never stored
// ---------------------------------------------------------------------------

/** Sent and still within its validity (validUntil is today or later, Cairo). */
const openWhere = (today: string): Prisma.QuoteWhereInput => ({ status: "sent", validUntil: { gte: toDate(today) } });

/** Sent, and validUntil is before today (Cairo): nobody answered in time. */
const expiredWhere = (today: string): Prisma.QuoteWhereInput => ({ status: "sent", validUntil: { lt: toDate(today) } });

function statusWhere(status: QuoteListStatus, today: string): Prisma.QuoteWhereInput {
  switch (status) {
    case "all":
      return {};
    case "sent":
      return openWhere(today);
    case "expired":
      return expiredWhere(today);
    default:
      return { status };
  }
}

function displayStatus(row: { status: QuoteStatus; validUntil: Date }, today: string) {
  const validUntil = toIso(row.validUntil);
  if (row.status === "sent") {
    return validUntil < today
      ? { status: "expired" as const, daysLeft: null }
      : { status: "sent" as const, daysLeft: daysBetween(today, validUntil) };
  }
  return { status: row.status, daysLeft: null };
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
  validUntil: true,
  customerId: true,
  customerName: true,
  total: true,
  convertedInvoice: { select: { id: true, number: true, numberPrefix: true } },
} satisfies Prisma.QuoteSelect;

type ListRow = Prisma.QuoteGetPayload<{ select: typeof listSelect }>;

function toListDto(row: ListRow, today: string) {
  const invoice = row.convertedInvoice;
  return {
    id: row.id,
    number: row.number,
    displayNumber: `${row.numberPrefix}${row.number}`,
    customerId: row.customerId,
    customer: row.customerName,
    issueDate: toIso(row.issueDate),
    validUntil: toIso(row.validUntil),
    total: moneyString(row.total),
    ...displayStatus(row, today),
    invoice: invoice ? { id: invoice.id, number: invoice.number, displayNumber: `${invoice.numberPrefix}${invoice.number}` } : null,
  };
}

const detailSelect = {
  ...listSelect,
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
  decidedAt: true,
  decidedBy: true,
  createdAt: true,
  lines: {
    orderBy: { position: "asc" },
    select: { id: true, description: true, quantity: true, unitPrice: true, amount: true, productId: true },
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
      logoFileId: true,
    },
  },
} satisfies Prisma.QuoteSelect;

type DetailRow = Prisma.QuoteGetPayload<{ select: typeof detailSelect }>;

function toDetailDto(row: DetailRow, today: string) {
  return {
    ...toListDto(row, today),
    currency: row.company.currency,
    issuer: {
      name: row.company.name,
      taxNumber: row.company.taxNumber,
      commercialRegister: row.company.commercialRegister,
      location: row.company.address,
      phone: row.company.phone,
      logoId: row.company.logoFileId,
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
    // Same layout as invoices; totals are exact, so it is always 0.
    rounding: "0.00",
    note: row.notes,
    publicToken: row.publicToken,
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt,
    history: row.events.map((e) => ({ id: e.id, type: e.type, at: e.createdAt.toISOString(), values: e.values })),
  };
}

/**
 * The customer's page behind the public link: only what the customer reads, listed
 * one by one (no internal ids, token, history, invoice link or who answered).
 */
function toPublicDto(row: DetailRow, today: string) {
  const d = toDetailDto(row, today);
  return {
    number: d.number,
    displayNumber: d.displayNumber,
    customer: d.customer,
    issueDate: d.issueDate,
    validUntil: d.validUntil,
    total: d.total,
    status: d.status,
    daysLeft: d.daysLeft,
    currency: d.currency,
    issuer: d.issuer,
    client: d.client,
    // Numbered 1, 2, 3...: the page only needs a key per line, not the line's id.
    lines: d.lines.map((line, index) => ({
      id: String(index + 1),
      title: line.title,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      amount: line.amount,
    })),
    subtotal: d.subtotal,
    vatRate: d.vatRate,
    vat: d.vat,
    rounding: d.rounding,
    note: d.note,
    sentAt: d.sentAt,
    decidedAt: d.decidedAt,
  };
}

export type QuoteListDto = ReturnType<typeof toListDto>;
export type QuoteDetailDto = ReturnType<typeof toDetailDto>;
export type PublicQuoteDto = ReturnType<typeof toPublicDto>;

// ---------------------------------------------------------------------------
// Finding a quote: by id (uuid) or by its number (/quotes/212)
// ---------------------------------------------------------------------------

export type QuoteRef = { id: string } | { number: number };

export function parseQuoteRef(value: unknown): QuoteRef {
  const ref = String(value ?? "");
  if (/^\d{1,9}$/.test(ref)) return { number: Number(ref) };
  if (/^[0-9a-f-]{36}$/i.test(ref)) return { id: ref };
  throw notFound("Quote");
}

async function findRow<T extends Prisma.QuoteSelect>(db: Tx, companyId: string, ref: QuoteRef, select: T) {
  const row = await db.quote.findFirst({ where: { companyId, ...ref }, select });
  if (!row) throw notFound("Quote");
  return row as Prisma.QuoteGetPayload<{ select: T }>;
}

export async function getQuote(companyId: string, ref: QuoteRef) {
  return toDetailDto(await findRow(prisma, companyId, ref, detailSelect), businessToday());
}

/** Public lookup by the secret token. A draft has no token, and is never shown. */
async function findPublicRow<T extends Prisma.QuoteSelect>(token: string, select: T) {
  const row = await prisma.quote.findFirst({ where: { publicToken: token, status: { not: "draft" } }, select });
  if (!row) throw notFound("Quote");
  return row as Prisma.QuoteGetPayload<{ select: T }>;
}

export async function getPublicQuote(token: string) {
  return toPublicDto(await findPublicRow(token, detailSelect), businessToday());
}

// ---------------------------------------------------------------------------
// List and stats
// ---------------------------------------------------------------------------

/** The filters other than status (search and period); the tab counts follow these too. */
function filterWhere(companyId: string, query: ListQuotesQuery, today: string) {
  const and: Prisma.QuoteWhereInput[] = [{ companyId }];

  const range =
    query.period === "month"
      ? monthRange(today)
      : query.period === "lastMonth"
        ? monthRange(today, -1)
        : query.period === "year"
          ? yearRange(today)
          : null;
  if (range) and.push({ issueDate: { gte: toDate(range.start), lte: toDate(range.end) } });

  if (query.q) {
    const nameMatch: Prisma.QuoteWhereInput = { customerName: { contains: query.q, mode: "insensitive" } };
    // "#212", "212" or "Q-212" also find quote 212.
    const number = query.q.match(/^[A-Za-z-]*#?(\d{1,9})$/)?.[1];
    and.push(number ? { OR: [{ number: Number(number) }, nameMatch] } : nameMatch);
  }

  if (query.converted === "false") and.push({ convertedInvoiceId: null });
  if (query.converted === "true") and.push({ convertedInvoiceId: { not: null } });
  return and;
}

export async function listQuotes(companyId: string, query: ListQuotesQuery) {
  const today = businessToday();
  const filters = filterWhere(companyId, query, today);
  const whereFor = (status: QuoteListStatus): Prisma.QuoteWhereInput => ({ AND: [...filters, statusWhere(status, today)] });
  const where = whereFor(query.status);

  const [rows, total, ...counts] = await prisma.$transaction([
    prisma.quote.findMany({
      where,
      select: listSelect,
      orderBy: [{ number: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.quote.count({ where }),
    // Tab counts: ignore the status tab, follow the search and the period.
    prisma.quote.count({ where: whereFor("all") }),
    prisma.quote.count({ where: whereFor("draft") }),
    prisma.quote.count({ where: whereFor("sent") }),
    prisma.quote.count({ where: whereFor("accepted") }),
    prisma.quote.count({ where: whereFor("rejected") }),
    prisma.quote.count({ where: whereFor("expired") }),
  ]);
  const [all, draft, sent, accepted, rejected, expired] = counts;

  return {
    items: rows.map((row) => toListDto(row, today)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts: { all, draft, sent, accepted, rejected, expired },
  };
}

/** The cards on top of the quotes page. */
export async function quoteStats(companyId: string) {
  const today = businessToday();
  const month = monthRange(today);
  const windowStart = toDate(addDays(today, -(ACCEPTANCE_WINDOW_DAYS - 1)));
  const sum = { _count: true, _sum: { total: true } } as const;

  const [waiting, [acceptedThisMonth], expiring, accepted, rejected, expired] = await Promise.all([
    prisma.quote.aggregate({ where: { companyId, ...openWhere(today) }, ...sum }),
    // Accepted this month by the Cairo calendar: decidedAt is an instant, so the
    // date is taken in Cairo time, not UTC.
    prisma.$queryRaw<{ count: number; total: Decimal }[]>`
      SELECT COUNT(*)::int AS count, COALESCE(SUM("total"), 0) AS total
      FROM "quotes"
      WHERE "companyId" = ${companyId}
        AND "status" = 'accepted'
        AND ("decidedAt" AT TIME ZONE ${BUSINESS_TIME_ZONE}::text)::date
            BETWEEN ${toDate(month.start)}::date AND ${toDate(month.end)}::date`,
    prisma.quote.aggregate({
      where: {
        companyId,
        status: "sent",
        validUntil: { gte: toDate(today), lte: toDate(addDays(today, EXPIRING_WITHIN_DAYS)) },
      },
      ...sum,
    }),
    // Acceptance rate: of the quotes issued recently that got an outcome.
    prisma.quote.count({ where: { companyId, status: "accepted", issueDate: { gte: windowStart } } }),
    prisma.quote.count({ where: { companyId, status: "rejected", issueDate: { gte: windowStart } } }),
    prisma.quote.count({ where: { companyId, ...expiredWhere(today), issueDate: { gte: windowStart } } }),
  ]);

  const decided = accepted + rejected + expired;
  return {
    waiting: { count: waiting._count, total: moneyString(waiting._sum.total ?? ZERO) },
    accepted: {
      count: acceptedThisMonth?.count ?? 0,
      total: moneyString(new Decimal(acceptedThisMonth?.total ?? 0)),
    },
    expiring: { count: expiring._count, total: moneyString(expiring._sum.total ?? ZERO) },
    // null when nothing in the window was decided yet.
    acceptanceRate: decided === 0 ? null : Math.round((100 * accepted) / decided),
  };
}

// ---------------------------------------------------------------------------
// Create, edit, duplicate
// ---------------------------------------------------------------------------

const invalidCustomer = () =>
  new AppError(400, "INVALID_CUSTOMER", "Choose a customer of this company", { field: "customerId" });
const invalidProduct = () => new AppError(400, "INVALID_PRODUCT", "An item is not in this company's catalog");
const notDraft = () => new AppError(409, "QUOTE_NOT_DRAFT", "Only a draft quote can be changed or sent");
const futureIssueDate = (status: 400 | 409) =>
  new AppError(status, "FUTURE_ISSUE_DATE", "A quote can't be sent with a date after today", { field: "issueDate" });
// Sending a quote that has already run out would only reach the customer as expired.
const validityPassed = (status: 400 | 409) =>
  new AppError(status, "QUOTE_VALIDITY_PASSED", "The quote's validity date has passed; change it before sending", {
    field: "validUntil",
  });

type Item = LineInput & { description: string; productId?: string | null | undefined };

/** The customer's details copied onto the quote. */
async function customerSnapshot(companyId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true, name: true, taxNumber: true, email: true, phone: true, city: true },
  });
  if (!customer) throw invalidCustomer();
  return customer;
}

type Customer = Awaited<ReturnType<typeof customerSnapshot>>;

const snapshotData = (customer: Customer) => ({
  customerId: customer.id,
  customerName: customer.name,
  customerTaxNumber: customer.taxNumber,
  customerEmail: customer.email,
  customerPhone: customer.phone,
  customerCity: customer.city,
});

/** Linked catalog items must belong to the same company. */
async function assertProducts(companyId: string, items: Item[]) {
  const productIds = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  if (productIds.length === 0) return;
  const found = await prisma.product.count({ where: { id: { in: productIds }, companyId } });
  if (found !== productIds.length) throw invalidProduct();
}

/** Line rows and totals, with VAT from the company's current setting. */
function priced(items: Item[], vatEnabled: boolean) {
  const vatRate = vatEnabled ? VAT_RATE : 0;
  const { amounts, subtotal, vat, total } = invoiceTotals(items, vatRate);
  const lines = items.map((item, position) => ({
    position,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: amounts[position]!,
    productId: item.productId ?? null,
  }));
  return { lines, totals: { subtotal, vatRate, vat, total } };
}

/**
 * The database refused a link: the customer or a catalog item was deleted between
 * the checks and the write. Same answer as if it had never been there.
 */
function rethrowWriteError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Only possible if the "next number" in the settings was set to a used one.
    if (err.code === "P2002") {
      throw new AppError(409, "QUOTE_NUMBER_USED", "The next quote number is already used; change it in the settings");
    }
    if (err.code === "P2003") {
      // The meta names the constraint (quote_lines_productId_fkey or quotes_customerId_fkey).
      throw JSON.stringify(err.meta ?? {}).includes("productId_fkey") ? invalidProduct() : invalidCustomer();
    }
  }
  throw err;
}

async function actorName(userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }))?.fullName ?? "";
}

type NewQuote = {
  customer: Customer;
  issueDate: string;
  validUntil: string;
  items: Item[];
  notes: string | null;
  send: boolean;
};

/** Writes a new quote with the company's next number; returns its id. */
async function insertQuote(actor: Actor, input: NewQuote, event: "quoteCreated" | "quoteDuplicated") {
  const name = await actorName(actor.id);
  try {
    return await prisma.$transaction(async (tx) => {
      // Taking the number: the update locks the company row until this transaction
      // ends, so two quotes created at the same moment never get the same number.
      const company = await tx.company.update({
        where: { id: actor.companyId },
        data: { quoteNextNumber: { increment: 1 } },
        select: { quoteNextNumber: true, quotePrefix: true, vatEnabled: true },
      });
      const { lines, totals } = priced(input.items, company.vatEnabled);
      const now = Date.now();

      const quote = await tx.quote.create({
        data: {
          number: company.quoteNextNumber - 1,
          numberPrefix: company.quotePrefix,
          status: input.send ? "sent" : "draft",
          issueDate: toDate(input.issueDate),
          validUntil: toDate(input.validUntil),
          ...snapshotData(input.customer),
          ...totals,
          notes: input.notes,
          publicToken: input.send ? generateToken() : null,
          sentAt: input.send ? new Date(now) : null,
          companyId: actor.companyId,
          createdById: actor.id,
          lines: { create: lines },
          events: {
            create: [
              { type: "created", values: { name }, userId: actor.id, createdAt: new Date(now) },
              ...(input.send
                ? [{ type: "sent" as const, values: {}, userId: actor.id, createdAt: new Date(now + 1) }]
                : []),
            ],
          },
        },
        select: { id: true, number: true, numberPrefix: true },
      });
      await audit(tx, actor.companyId, {
        action: "create",
        event: input.send ? "quoteCreatedSent" : event,
        item: { type: "quote", id: quote.id, ref: `${quote.numberPrefix}${quote.number}` },
        values: { number: quote.number, amount: moneyString(totals.total), customer: input.customer.name },
      });
      return quote.id;
    });
  } catch (err) {
    rethrowWriteError(err);
  }
}

export async function createQuote(actor: Actor, input: CreateQuoteInput) {
  const customer = await customerSnapshot(actor.companyId, input.customerId);
  await assertProducts(actor.companyId, input.items);
  // A sent quote can't carry a date after today (a draft may, until it is sent), and
  // must still be valid today.
  if (input.send && input.issueDate > businessToday()) throw futureIssueDate(400);
  if (input.send && input.validUntil < businessToday()) throw validityPassed(400);

  const id = await insertQuote(actor, {
    customer,
    issueDate: input.issueDate,
    validUntil: input.validUntil,
    items: input.items,
    notes: input.notes ?? null,
    send: input.send,
  }, "quoteCreated");
  return getQuote(actor.companyId, { id });
}

/**
 * Replaces a draft: customer (snapshot refreshed), dates, notes and lines. Totals
 * are worked out again with the current VAT setting.
 */
export async function updateQuote(actor: Actor, ref: QuoteRef, input: UpdateQuoteInput) {
  const row = await findRow(prisma, actor.companyId, ref, { id: true, status: true, number: true, numberPrefix: true });
  if (row.status !== "draft") throw notDraft();
  const customer = await customerSnapshot(actor.companyId, input.customerId);
  await assertProducts(actor.companyId, input.items);

  try {
    await prisma.$transaction(async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: actor.companyId },
        select: { vatEnabled: true },
      });
      const { lines, totals } = priced(input.items, company.vatEnabled);

      // Still a draft, checked in the update itself (it may have been sent meanwhile).
      const { count } = await tx.quote.updateMany({
        where: { id: row.id, companyId: actor.companyId, status: "draft" },
        data: {
          issueDate: toDate(input.issueDate),
          validUntil: toDate(input.validUntil),
          ...snapshotData(customer),
          ...totals,
          notes: input.notes ?? null,
        },
      });
      if (count === 0) throw await missingOr(tx, row.id, notDraft());

      await tx.quoteLine.deleteMany({ where: { quoteId: row.id } });
      await tx.quoteLine.createMany({ data: lines.map((line) => ({ ...line, quoteId: row.id })) });
      await audit(tx, actor.companyId, {
        action: "update",
        event: "quoteUpdated",
        item: { type: "quote", id: row.id, ref: `${row.numberPrefix}${row.number}` },
        values: { number: row.number, amount: moneyString(totals.total), customer: customer.name },
      });
    });
  } catch (err) {
    rethrowWriteError(err);
  }
  return getQuote(actor.companyId, { id: row.id });
}

/**
 * A new draft with the next number: same customer (its current details), lines and
 * notes; dated today and valid for as many days as the original.
 */
export async function duplicateQuote(actor: Actor, ref: QuoteRef) {
  const original = await findRow(prisma, actor.companyId, ref, {
    customerId: true,
    issueDate: true,
    validUntil: true,
    notes: true,
    lines: {
      orderBy: { position: "asc" },
      select: { description: true, quantity: true, unitPrice: true, productId: true },
    },
  });
  // The customer was deleted since: the user has to pick one (create a new quote).
  if (!original.customerId) throw invalidCustomer();
  const customer = await customerSnapshot(actor.companyId, original.customerId);

  const today = businessToday();
  const validDays = daysBetween(toIso(original.issueDate), toIso(original.validUntil));
  const id = await insertQuote(actor, {
    customer,
    issueDate: today,
    validUntil: addDays(today, validDays),
    items: original.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toFixed(2),
      productId: line.productId,
    })),
    notes: original.notes,
    send: false,
  }, "quoteDuplicated");
  return getQuote(actor.companyId, { id });
}

/** A conditional update found nothing: the quote is gone (404), or `otherwise`. */
async function missingOr(db: Tx, id: string, otherwise: AppError) {
  const exists = await db.quote.count({ where: { id } });
  return exists === 0 ? notFound("Quote") : otherwise;
}

// ---------------------------------------------------------------------------
// Send, accept, reject
// ---------------------------------------------------------------------------

/** Sends a draft: it gets its public link. */
export async function sendQuote(actor: Actor, ref: QuoteRef) {
  const today = businessToday();
  await prisma.$transaction(async (tx) => {
    const row = await findRow(tx, actor.companyId, ref, {
      id: true,
      number: true,
      numberPrefix: true,
      total: true,
      customerName: true,
    });
    // Draft, not dated after today and still valid today, checked in the update itself,
    // so two clicks (or an edit at the same moment) can't get around it.
    const { count } = await tx.quote.updateMany({
      where: {
        id: row.id,
        status: "draft",
        issueDate: { lte: toDate(today) },
        validUntil: { gte: toDate(today) },
      },
      data: { status: "sent", sentAt: new Date(), publicToken: generateToken() },
    });
    if (count === 0) {
      const now = await tx.quote.findUnique({
        where: { id: row.id },
        select: { status: true, issueDate: true },
      });
      if (!now) throw notFound("Quote");
      if (now.status !== "draft") throw notDraft();
      throw toIso(now.issueDate) > today ? futureIssueDate(409) : validityPassed(409);
    }
    await tx.quoteEvent.create({ data: { quoteId: row.id, type: "sent", userId: actor.id } });
    await audit(tx, actor.companyId, {
      action: "send",
      event: "quoteSent",
      item: { type: "quote", id: row.id, ref: `${row.numberPrefix}${row.number}` },
      values: { number: row.number, amount: moneyString(row.total), customer: row.customerName },
    });
  });
  return getQuote(actor.companyId, ref);
}

type Decision = "accepted" | "rejected";

/**
 * Records the customer's answer on their behalf (by phone, email...). A sent quote
 * only; an expired one too, since the customer may answer late.
 */
export async function decideQuote(actor: Actor, ref: QuoteRef, decision: Decision) {
  await prisma.$transaction(async (tx) => {
    const row = await findRow(tx, actor.companyId, ref, {
      id: true,
      number: true,
      numberPrefix: true,
      total: true,
      customerName: true,
    });
    const { count } = await tx.quote.updateMany({
      where: { id: row.id, status: "sent" },
      data: { status: decision, decidedAt: new Date(), decidedBy: "user" },
    });
    if (count === 0) {
      throw await missingOr(
        tx,
        row.id,
        new AppError(409, "QUOTE_NOT_SENT", "Only a sent quote can be accepted or rejected"),
      );
    }
    await tx.quoteEvent.create({ data: { quoteId: row.id, type: decision, values: { by: "user" }, userId: actor.id } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: decision === "accepted" ? "quoteAccepted" : "quoteRejected",
      item: { type: "quote", id: row.id, ref: `${row.numberPrefix}${row.number}` },
      values: { number: row.number, amount: moneyString(row.total), customer: row.customerName },
    });
  });
  return getQuote(actor.companyId, ref);
}

/**
 * The customer's answer through the public link: only while the quote is sent and
 * still valid (an expired offer can't be accepted by the customer).
 */
export async function answerPublicQuote(token: string, decision: Decision) {
  const today = businessToday();
  const row = await findPublicRow(token, {
    id: true,
    companyId: true,
    number: true,
    numberPrefix: true,
    total: true,
    customerName: true,
  });
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.quote.updateMany({
      where: { id: row.id, status: "sent", validUntil: { gte: toDate(today) } },
      data: { status: decision, decidedAt: new Date(), decidedBy: "customer" },
    });
    if (count === 0) {
      throw await missingOr(
        tx,
        row.id,
        new AppError(409, "QUOTE_NOT_OPEN", "This quote can no longer be accepted or rejected"),
      );
    }
    await tx.quoteEvent.create({ data: { quoteId: row.id, type: decision, values: { by: "customer" } } });
    await audit(
      tx,
      row.companyId,
      {
        action: "update",
        event: decision === "accepted" ? "quoteAcceptedByCustomer" : "quoteRejectedByCustomer",
        item: { type: "quote", id: row.id, ref: `${row.numberPrefix}${row.number}` },
        values: { number: row.number, amount: moneyString(row.total), customer: row.customerName, viaLink: true },
      },
      { id: null, name: row.customerName },
    );
  });
  return getPublicQuote(token);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * A draft: anyone with the quotes permission. A sent, accepted or rejected quote:
 * the owner only. A quote that became an invoice: never (the invoice points to it).
 */
export async function deleteQuote(actor: Actor, ref: QuoteRef) {
  const row = await findRow(prisma, actor.companyId, ref, {
    id: true,
    number: true,
    numberPrefix: true,
    status: true,
    total: true,
    customerName: true,
  });
  const owner = can(actor.role, "deleteData");

  // One statement with every condition, so a quote sent or converted at the same
  // moment isn't deleted by someone who no longer may.
  const count = await prisma.$transaction(async (tx) => {
    const { count } = await tx.quote.deleteMany({
      where: { id: row.id, companyId: actor.companyId, convertedInvoiceId: null, ...(owner ? {} : { status: "draft" }) },
    });
    if (count > 0) {
      await audit(tx, actor.companyId, {
        action: "delete",
        event: "quoteDeleted",
        item: { type: "quote", ref: `${row.numberPrefix}${row.number}` },
        values: { amount: moneyString(row.total), customer: row.customerName, status: row.status },
      });
    }
    return count;
  });
  if (count > 0) return;

  const now = await prisma.quote.findUnique({ where: { id: row.id }, select: { convertedInvoiceId: true } });
  if (!now) throw notFound("Quote");
  if (now.convertedInvoiceId) {
    throw new AppError(409, "QUOTE_CONVERTED", "A quote that was turned into an invoice can't be deleted");
  }
  throw new AppError(403, "FORBIDDEN", "Only the owner can delete a quote that was sent");
}
