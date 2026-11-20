import type { Prisma, RecurringEndMode, Role } from "../../generated/prisma/client.js";
import { addDays, addMonths, businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { Decimal, invoiceTotals, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { createInvoice, VAT_RATE } from "../invoices/invoices.service.js";
import type { ListRecurringQuery, RecurringFrequency, RecurringInput } from "./recurring.schemas.js";

type Actor = { id: string; companyId: string; role: Role };

/** How many due invoices one template may make in a single run (a long outage catches up over a few runs). */
const MAX_PER_RUN = 24;
/** "Coming up" in the stats: due within this many days. */
const UPCOMING_DAYS = 7;
const LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 } as const;

/**
 * The k-th scheduled date (k = 0 is the start date). Always counted from the start
 * date, so a monthly schedule from the 31st gives Feb 28 and then Mar 31 again.
 */
export function scheduledDate(startDate: string, frequency: RecurringFrequency, index: number) {
  return frequency === "weekly" ? addDays(startDate, 7 * index) : addMonths(startDate, STEP_MONTHS[frequency] * index);
}

type Schedule = {
  startDate: string;
  frequency: RecurringFrequency;
  endMode: RecurringEndMode;
  endDate: string | null;
  maxCount: number | null;
  generatedCount: number;
};

/** The date at `index`, or "ended" when the template has no more invoices to make. */
function stateAt(s: Schedule, index: number): { ended: true } | { ended: false; nextIndex: number; nextDate: string } {
  if (s.endMode === "count" && s.maxCount !== null && s.generatedCount >= s.maxCount) return { ended: true };
  const nextDate = scheduledDate(s.startDate, s.frequency, index);
  if (s.endMode === "date" && s.endDate !== null && nextDate > s.endDate) return { ended: true };
  return { ended: false, nextIndex: index, nextDate };
}

/** The first scheduled date from `today` on (at index `from` or later): resuming skips the missed ones. */
function firstIndexFrom(s: Pick<Schedule, "startDate" | "frequency">, today: string, from: number) {
  let index = from;
  while (scheduledDate(s.startDate, s.frequency, index) < today) index++;
  return index;
}

/** Its value per month, to add up the monthly recurring revenue. */
const MONTHLY_FACTOR: Record<RecurringFrequency, Decimal> = {
  weekly: new Decimal(52).dividedBy(12),
  monthly: new Decimal(1),
  quarterly: new Decimal(1).dividedBy(3),
  yearly: new Decimal(1).dividedBy(12),
};

// ---------------------------------------------------------------------------
// Shapes sent to the frontend
// ---------------------------------------------------------------------------

const invoiceRef = { id: true, number: true, numberPrefix: true, issueDate: true } satisfies Prisma.InvoiceSelect;

const listSelect = {
  id: true,
  name: true,
  frequency: true,
  total: true,
  nextDate: true,
  generatedCount: true,
  autoSend: true,
  status: true,
  endMode: true,
  endDate: true,
  maxCount: true,
  lastError: true,
  customerId: true,
  customer: { select: { name: true } },
  invoices: { orderBy: [{ recurringRunDate: "desc" }], take: 1, select: invoiceRef },
} satisfies Prisma.RecurringInvoiceSelect;

type ListRow = Prisma.RecurringInvoiceGetPayload<{ select: typeof listSelect }>;

const displayNumber = (i: { number: number; numberPrefix: string }) => `${i.numberPrefix}${i.number}`;

function toListDto(row: ListRow) {
  const last = row.invoices[0];
  return {
    id: row.id,
    name: row.name,
    customerId: row.customerId,
    customer: row.customer.name,
    frequency: row.frequency,
    total: moneyString(row.total),
    nextDate: row.nextDate ? toIso(row.nextDate) : null,
    generatedCount: row.generatedCount,
    autoSend: row.autoSend,
    status: row.status,
    endMode: row.endMode,
    endDate: row.endDate ? toIso(row.endDate) : null,
    occurrences: row.maxCount,
    // Why the last invoice couldn't be made (e.g. the next number is taken); null when fine.
    lastError: row.lastError,
    lastInvoice: last
      ? { id: last.id, number: last.number, displayNumber: displayNumber(last), issueDate: toIso(last.issueDate) }
      : null,
  };
}

const detailSelect = {
  ...listSelect,
  startDate: true,
  paymentTermsDays: true,
  notes: true,
  subtotal: true,
  vatRate: true,
  vat: true,
  lines: {
    orderBy: { position: "asc" },
    select: { id: true, description: true, quantity: true, unitPrice: true, productId: true },
  },
} satisfies Prisma.RecurringInvoiceSelect;

type DetailRow = Prisma.RecurringInvoiceGetPayload<{ select: typeof detailSelect }>;

async function toDetailDto(row: DetailRow) {
  // The latest invoices it made, newest first.
  const invoices = await prisma.invoice.findMany({
    where: { recurringId: row.id },
    orderBy: [{ recurringRunDate: "desc" }],
    take: 10,
    select: { ...invoiceRef, total: true, status: true },
  });
  return {
    ...toListDto(row),
    startDate: toIso(row.startDate),
    terms: row.paymentTermsDays,
    notes: row.notes,
    lines: row.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity.toString(),
      unitPrice: moneyString(line.unitPrice),
      productId: line.productId,
    })),
    subtotal: moneyString(row.subtotal),
    vatRate: row.vatRate.toFixed(2),
    vat: moneyString(row.vat),
    invoices: invoices.map((i) => ({
      id: i.id,
      number: i.number,
      displayNumber: displayNumber(i),
      issueDate: toIso(i.issueDate),
      total: moneyString(i.total),
      status: i.status,
    })),
  };
}

export type RecurringListDto = ReturnType<typeof toListDto>;
export type RecurringDetailDto = Awaited<ReturnType<typeof toDetailDto>>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The templates (filtered), the tab counts, and stats over all of them. */
export async function listRecurring(companyId: string, query: ListRecurringQuery) {
  const today = businessToday();
  const search: Prisma.RecurringInvoiceWhereInput = query.q
    ? {
        OR: [
          { name: { contains: query.q, mode: "insensitive" } },
          { customer: { name: { contains: query.q, mode: "insensitive" } } },
        ],
      }
    : {};
  const base: Prisma.RecurringInvoiceWhereInput = { companyId, ...search };

  const [rows, all, active, paused, ended, activeForStats, pausedCount] = await prisma.$transaction([
    prisma.recurringInvoice.findMany({
      where: { ...base, ...(query.status === "all" ? {} : { status: query.status }) },
      select: listSelect,
      // Active first by the next date, then paused, then ended (the enum's order).
      orderBy: [{ status: "asc" }, { nextDate: "asc" }, { createdAt: "desc" }],
      take: LIST_LIMIT,
    }),
    prisma.recurringInvoice.count({ where: base }),
    prisma.recurringInvoice.count({ where: { ...base, status: "active" } }),
    prisma.recurringInvoice.count({ where: { ...base, status: "paused" } }),
    prisma.recurringInvoice.count({ where: { ...base, status: "ended" } }),
    // Stats are over all of the company's templates, whatever the filters.
    prisma.recurringInvoice.findMany({
      where: { companyId, status: "active" },
      select: { frequency: true, total: true, nextDate: true },
    }),
    prisma.recurringInvoice.count({ where: { companyId, status: "paused" } }),
  ]);

  const soon = addDays(today, UPCOMING_DAYS);
  const upcoming = activeForStats.filter((t) => t.nextDate && toIso(t.nextDate) >= today && toIso(t.nextDate) <= soon);
  const mrr = activeForStats.reduce((sum, t) => sum.plus(t.total.times(MONTHLY_FACTOR[t.frequency])), ZERO);

  return {
    today,
    items: rows.map(toListDto),
    counts: { all, active, paused, ended },
    stats: {
      mrr: moneyString(money(mrr)),
      active: activeForStats.length,
      paused: pausedCount,
      upcoming: { count: upcoming.length, total: moneyString(upcoming.reduce((sum, t) => sum.plus(t.total), ZERO)) },
    },
  };
}

export async function getRecurring(companyId: string, id: string) {
  const row = await prisma.recurringInvoice.findFirst({ where: { id, companyId }, select: detailSelect });
  if (!row) throw notFound("Recurring invoice");
  return toDetailDto(row);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const startDatePassed = () =>
  new AppError(400, "START_DATE_PASSED", "The first invoice can't be dated before today", { field: "startDate" });
const notActive = () => new AppError(409, "RECURRING_NOT_ACTIVE", "Only an active recurring invoice can be paused");
const notPaused = () => new AppError(409, "RECURRING_NOT_PAUSED", "Only a paused recurring invoice can be resumed");
const ended = () => new AppError(409, "RECURRING_ENDED", "This recurring invoice has ended and can't be changed");
const changedMeanwhile = () =>
  new AppError(409, "RECURRING_CHANGED", "The recurring invoice made an invoice meanwhile; open it again and retry");

async function assertCustomer(companyId: string, customerId: string) {
  const found = await prisma.customer.count({ where: { id: customerId, companyId } });
  if (found === 0) throw new AppError(400, "INVALID_CUSTOMER", "Choose a customer of this company", { field: "customerId" });
}

async function assertProducts(companyId: string, items: RecurringInput["items"]) {
  const productIds = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  if (productIds.length === 0) return;
  const found = await prisma.product.count({ where: { id: { in: productIds }, companyId } });
  if (found !== productIds.length) throw new AppError(400, "INVALID_PRODUCT", "An item is not in this company's catalog");
}

/** Lines and totals, with the company's VAT setting as it is now. */
async function priced(companyId: string, items: RecurringInput["items"]) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { vatEnabled: true } });
  const vatRate = company.vatEnabled ? VAT_RATE : 0;
  const { amounts, subtotal, vat, total } = invoiceTotals(items, vatRate);
  const lines = items.map((item, position) => ({
    position,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    amount: amounts[position]!,
    productId: item.productId ?? null,
  }));
  return { lines, subtotal, vatRate, vat, total };
}

/** The end condition as stored: only the field its mode uses. */
function endFields(input: RecurringInput) {
  return {
    endMode: input.endMode,
    endDate: input.endMode === "date" && input.endDate ? input.endDate : null,
    maxCount: input.endMode === "count" ? (input.occurrences ?? null) : null,
  };
}

const templateData = (input: RecurringInput, totals: Awaited<ReturnType<typeof priced>>) => ({
  name: input.name,
  frequency: input.frequency,
  startDate: toDate(input.startDate),
  paymentTermsDays: input.terms,
  autoSend: input.autoSend,
  notes: input.notes ?? null,
  subtotal: totals.subtotal,
  vatRate: totals.vatRate,
  vat: totals.vat,
  total: totals.total,
  customerId: input.customerId,
});

export async function createRecurring(actor: Actor, input: RecurringInput) {
  const today = businessToday();
  if (input.startDate < today) throw startDatePassed();
  await assertCustomer(actor.companyId, input.customerId);
  await assertProducts(actor.companyId, input.items);
  const totals = await priced(actor.companyId, input.items);
  const end = endFields(input);

  const row = await prisma.recurringInvoice.create({
    data: {
      ...templateData(input, totals),
      ...end,
      endDate: end.endDate ? toDate(end.endDate) : null,
      nextIndex: 0,
      nextDate: toDate(input.startDate),
      status: "active",
      companyId: actor.companyId,
      createdById: actor.id,
      lines: { create: totals.lines },
    },
    select: { id: true },
  });

  // Starting today: the first invoice is made right away.
  await runTemplate(row.id, today);
  return getRecurring(actor.companyId, row.id);
}

/**
 * Replaces the template. Keeping the start date and frequency keeps the schedule
 * where it is; changing either starts it again from the new start date (today or later).
 */
export async function updateRecurring(actor: Actor, id: string, input: RecurringInput) {
  const today = businessToday();
  const existing = await prisma.recurringInvoice.findFirst({
    where: { id, companyId: actor.companyId },
    select: { startDate: true, frequency: true, status: true, nextIndex: true, generatedCount: true },
  });
  if (!existing) throw notFound("Recurring invoice");
  if (existing.status === "ended") throw ended();

  const restart = input.startDate !== toIso(existing.startDate) || input.frequency !== existing.frequency;
  if (restart && input.startDate < today) throw startDatePassed();
  await assertCustomer(actor.companyId, input.customerId);
  await assertProducts(actor.companyId, input.items);
  const totals = await priced(actor.companyId, input.items);
  const end = endFields(input);

  const state = stateAt(
    { ...end, startDate: input.startDate, frequency: input.frequency, generatedCount: existing.generatedCount },
    restart ? 0 : existing.nextIndex,
  );

  await prisma.$transaction(async (tx) => {
    // Not ended meanwhile (a run can end it): the condition is part of the update.
    const { count } = await tx.recurringInvoice.updateMany({
      where: { id, companyId: actor.companyId, status: { not: "ended" }, nextIndex: existing.nextIndex },
      data: {
        ...templateData(input, totals),
        ...end,
        endDate: end.endDate ? toDate(end.endDate) : null,
        ...(state.ended
          ? { status: "ended", nextDate: null }
          : { nextIndex: state.nextIndex, nextDate: toDate(state.nextDate) }),
        lastError: null,
      },
    });
    if (count === 0) {
      const now = await tx.recurringInvoice.findUnique({ where: { id }, select: { status: true } });
      throw now?.status === "ended" ? ended() : changedMeanwhile();
    }
    await tx.recurringInvoiceLine.deleteMany({ where: { recurringId: id } });
    await tx.recurringInvoiceLine.createMany({ data: totals.lines.map((line) => ({ ...line, recurringId: id })) });
  });

  await runTemplate(id, today);
  return getRecurring(actor.companyId, id);
}

export async function pauseRecurring(actor: Actor, id: string) {
  const { count } = await prisma.recurringInvoice.updateMany({
    where: { id, companyId: actor.companyId, status: "active" },
    data: { status: "paused" },
  });
  if (count === 0) {
    await getRecurring(actor.companyId, id); // 404 if it isn't there
    throw notActive();
  }
  return getRecurring(actor.companyId, id);
}

/** Resumes from the first scheduled date from today on: the dates missed while paused are skipped. */
export async function resumeRecurring(actor: Actor, id: string) {
  const today = businessToday();
  const row = await prisma.recurringInvoice.findFirst({
    where: { id, companyId: actor.companyId },
    select: {
      status: true,
      startDate: true,
      frequency: true,
      endMode: true,
      endDate: true,
      maxCount: true,
      generatedCount: true,
      nextIndex: true,
    },
  });
  if (!row) throw notFound("Recurring invoice");
  if (row.status !== "paused") throw notPaused();

  const schedule: Schedule = {
    startDate: toIso(row.startDate),
    frequency: row.frequency,
    endMode: row.endMode,
    endDate: row.endDate ? toIso(row.endDate) : null,
    maxCount: row.maxCount,
    generatedCount: row.generatedCount,
  };
  const state = stateAt(schedule, firstIndexFrom(schedule, today, row.nextIndex));
  const { count } = await prisma.recurringInvoice.updateMany({
    where: { id, companyId: actor.companyId, status: "paused" },
    data: state.ended
      ? { status: "ended", nextDate: null }
      : { status: "active", nextIndex: state.nextIndex, nextDate: toDate(state.nextDate), lastError: null },
  });
  if (count === 0) throw notPaused();

  await runTemplate(id, today);
  return getRecurring(actor.companyId, id);
}

/** The invoices it already made stay (they just lose the link to the template). */
export async function deleteRecurring(actor: Actor, id: string) {
  const { count } = await prisma.recurringInvoice.deleteMany({ where: { id, companyId: actor.companyId } });
  if (count === 0) throw notFound("Recurring invoice");
}

// ---------------------------------------------------------------------------
// Making the invoices
// ---------------------------------------------------------------------------

/** Who the invoice is "created by": the template's author, else the company's owner. */
async function invoiceAuthor(companyId: string, createdById: string | null) {
  if (createdById) return createdById;
  const owner = await prisma.user.findFirst({
    where: { companyId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });
  return owner?.id ?? null;
}

/**
 * Makes every invoice of one template that is due by `today`, each dated on its
 * scheduled date (so a day the server was down is caught up). Safe to run twice at
 * once: the invoice for a template and date is unique, and the schedule only moves
 * forward from the step it read.
 */
export async function runTemplate(id: string, today = businessToday()) {
  let made = 0;
  for (let step = 0; step < MAX_PER_RUN; step++) {
    const t = await prisma.recurringInvoice.findUnique({
      where: { id },
      select: {
        companyId: true,
        customerId: true,
        createdById: true,
        status: true,
        nextIndex: true,
        nextDate: true,
        startDate: true,
        frequency: true,
        endMode: true,
        endDate: true,
        maxCount: true,
        generatedCount: true,
        paymentTermsDays: true,
        autoSend: true,
        notes: true,
        lines: { orderBy: { position: "asc" }, select: { description: true, quantity: true, unitPrice: true, productId: true } },
      },
    });
    if (!t || t.status !== "active" || !t.nextDate || toIso(t.nextDate) > today) break;
    const runDate = toIso(t.nextDate);

    const alreadyMade = () =>
      prisma.invoice.count({ where: { recurringId: id, recurringRunDate: t.nextDate! } }).then((n) => n > 0);

    if (!(await alreadyMade())) {
      try {
        const author = await invoiceAuthor(t.companyId, t.createdById);
        if (!author) throw new Error("The company has no user to issue the invoice as");
        await createInvoice(
          { id: author, companyId: t.companyId },
          {
            customerId: t.customerId,
            issueDate: runDate,
            terms: t.paymentTermsDays,
            items: t.lines.map((line) => ({
              description: line.description,
              quantity: line.quantity.toString(),
              unitPrice: line.unitPrice.toFixed(2),
              productId: line.productId,
            })),
            notes: t.notes,
            send: t.autoSend,
          },
          { recurringId: id, runDate },
        );
        made++;
      } catch (err) {
        // Another run made this one at the same moment: carry on. Anything else: note
        // it on the template (the next run tries again) and stop for now.
        if (!(await alreadyMade())) {
          const message = err instanceof AppError ? err.code : "RECURRING_RUN_FAILED";
          await prisma.recurringInvoice.update({ where: { id }, data: { lastError: message, lastRunAt: new Date() } });
          logger.warn({ err, recurringId: id, runDate }, "Recurring invoice could not be made");
          break;
        }
      }
    }

    // On to the next date (or the end). Only from the step that was read, so two
    // runs at once move it once.
    const generatedCount = await prisma.invoice.count({ where: { recurringId: id } });
    const state = stateAt(
      {
        startDate: toIso(t.startDate),
        frequency: t.frequency,
        endMode: t.endMode,
        endDate: t.endDate ? toIso(t.endDate) : null,
        maxCount: t.maxCount,
        generatedCount,
      },
      t.nextIndex + 1,
    );
    await prisma.recurringInvoice.updateMany({
      where: {
        id,
        status: "active",
        nextIndex: t.nextIndex,
        nextDate: t.nextDate,
        startDate: t.startDate,
        frequency: t.frequency,
      },
      data: {
        generatedCount,
        lastRunAt: new Date(),
        lastError: null,
        ...(state.ended
          ? { status: "ended", nextDate: null, nextIndex: t.nextIndex + 1 }
          : { nextIndex: state.nextIndex, nextDate: toDate(state.nextDate) }),
      },
    });
  }
  return made;
}

/** The job: every active template with an invoice due by today, across all companies. */
export async function runDueRecurring(today = businessToday()) {
  const due = await prisma.recurringInvoice.findMany({
    where: { status: "active", nextDate: { lte: toDate(today) } },
    select: { id: true },
    orderBy: [{ lastRunAt: { sort: "asc", nulls: "first" } }, { nextDate: "asc" }],
    take: 1000,
  });
  let invoices = 0;
  for (const t of due) {
    try {
      invoices += await runTemplate(t.id, today);
    } catch (err) {
      logger.error({ err, recurringId: t.id }, "Recurring run failed");
    }
  }
  return { templates: due.length, invoices };
}
