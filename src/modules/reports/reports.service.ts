import { Prisma, type ExpenseCategory } from "../../generated/prisma/client.js";
import { businessToday, monthRange, quarterRange, toDate, toIso, yearRange } from "../../lib/dates.js";
import { Decimal, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { changePct, expensesByMonth } from "../expenses/expenses.service.js";
import { creditNoteNumber, paymentNumber } from "../invoices/invoices.service.js";
import { payrollCostByMonth, withPayroll } from "../payroll/payroll.service.js";
import { ISSUED_SQL, ISSUED_STATUSES, revenueByMonth } from "./revenue.js";

type Range = { start: string; end: string };

const SERIES_MONTHS = 6;
const TOP_CUSTOMERS = 5;

const monthKey = (iso: string) => iso.slice(0, 7);
const within = (range: Range) => ({ gte: toDate(range.start), lte: toDate(range.end) });

// ---------------------------------------------------------------------------
// Period: "YYYY-MM", "thisQuarter" or "thisYear" (calendar), default this month
// ---------------------------------------------------------------------------

export function resolvePeriod(key: string | undefined, today: string) {
  const thisMonthEnd = monthRange(today).end;
  // "This quarter/year" so far: the months after this one haven't happened yet, so an
  // expense entered ahead of time (next month's rent) doesn't count before its month.
  const soFar = (range: Range) => ({ ...range, to: range.end < thisMonthEnd ? range.end : thisMonthEnd });
  if (key === "thisQuarter") return { key, ...soFar(quarterRange(today)), previous: quarterRange(today, -1) };
  if (key === "thisYear") return { key, ...soFar(yearRange(today)), previous: yearRange(today, -1) };
  const month = key ?? monthKey(today);
  const first = `${month}-01`;
  // A month is never after the current one (the schema refuses it), so it counts whole.
  const range = monthRange(first);
  return { key: month, ...range, to: range.end, previous: monthRange(first, -1) };
}

type Period = ReturnType<typeof resolvePeriod>;

/** The days a period's figures cover: its start up to `to` (see resolvePeriod). */
const counted = (p: Period): Range => ({ start: p.start, end: p.to });

const periodDto = (p: Period) => ({ key: p.key, start: p.start, end: p.end });

/** Adds up the months of `byMonth` inside `range` (report periods are whole months). */
function sumMonths(byMonth: Map<string, Decimal>, range: Range) {
  const from = monthKey(range.start);
  const to = monthKey(range.end);
  let sum = ZERO;
  for (const [month, amount] of byMonth) {
    if (month >= from && month <= to) sum = sum.plus(amount);
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Profit and loss summary
// ---------------------------------------------------------------------------

/** Expense lines in the order they are shown; purchases are the cost of sales. */
const EXPENSE_LINES = [
  { key: "purchases", kind: "cost" },
  { key: "salaries", kind: "expense" },
  { key: "rent", kind: "expense" },
  { key: "utilities", kind: "expense" },
  { key: "marketing", kind: "expense" },
  { key: "software", kind: "expense" },
] as const satisfies readonly { key: ExpenseCategory; kind: "cost" | "expense" }[];

/** Top customers by revenue (before VAT) on issued invoices in the period, with their current name. */
async function topCustomers(companyId: string, range: Range) {
  const rows = await prisma.$queryRaw<{ id: string; name: string; invoicesCount: number; revenue: Decimal }[]>`
    SELECT c."id", c."name", COUNT(*)::int AS "invoicesCount", SUM(i."subtotal") AS revenue
    FROM "invoices" i
    JOIN "customers" c ON c."id" = i."customerId"
    WHERE i."companyId" = ${companyId}
      AND c."companyId" = ${companyId}
      AND i."status" IN ${ISSUED_SQL}
      AND i."issueDate" BETWEEN ${toDate(range.start)}::date AND ${toDate(range.end)}::date
    GROUP BY c."id", c."name"
    ORDER BY revenue DESC, c."name" ASC, c."id" ASC
    LIMIT ${TOP_CUSTOMERS}`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    invoicesCount: r.invoicesCount,
    revenue: moneyString(new Decimal(r.revenue)),
  }));
}

export async function summary(companyId: string, periodKey: string | undefined) {
  const today = businessToday();
  const currentMonth = monthKey(today);
  const period = resolvePeriod(periodKey, today);

  // Chart: 6 months ending at the period's last month, or at this month if the period runs past it.
  const lastMonth = monthKey(period.end) < currentMonth ? monthKey(period.end) : currentMonth;
  const months = Array.from({ length: SERIES_MONTHS }, (_, i) =>
    monthKey(monthRange(`${lastMonth}-01`, i - (SERIES_MONTHS - 1)).start),
  );
  // One revenue and one expenses query cover the period, the previous period and the chart.
  const firstMonth = `${months[0]}-01`;
  const span = { start: firstMonth < period.previous.start ? firstMonth : period.previous.start, end: period.to };

  const [revenueMonths, expenseOnlyMonths, payrollMonths, byCategory, collected, top] = await Promise.all([
    revenueByMonth(companyId, span),
    expensesByMonth(companyId, span.start),
    payrollCostByMonth(companyId, span.start),
    prisma.expense.groupBy({
      by: ["category"],
      where: { companyId, date: within(counted(period)) },
      _sum: { amount: true, vat: true },
    }),
    // Collected = cleared payments only (a pending cheque isn't money in yet).
    prisma.invoicePayment.aggregate({
      where: { companyId, status: "cleared", date: within(counted(period)) },
      _sum: { amount: true },
    }),
    topCustomers(companyId, counted(period)),
  ]);

  // Approved payroll is a salaries cost, next to salaries entered as expenses.
  const expenseMonths = withPayroll(expenseOnlyMonths, payrollMonths);
  // The cost of each category: what was paid less the VAT in it (claimed back, not spent).
  const spent = new Map(byCategory.map((c) => [c.category, (c._sum.amount ?? ZERO).minus(c._sum.vat ?? ZERO)]));
  spent.set("salaries", (spent.get("salaries") ?? ZERO).plus(sumMonths(payrollMonths, counted(period))));
  const spentOn = (category: ExpenseCategory) => spent.get(category) ?? ZERO;

  const revenue = sumMonths(revenueMonths, counted(period));
  const cost = spentOn("purchases");
  const operating = EXPENSE_LINES.filter((l) => l.kind === "expense").reduce((sum, l) => sum.plus(spentOn(l.key)), ZERO);
  const expenses = cost.plus(operating);
  const grossProfit = revenue.minus(cost);
  const netProfit = grossProfit.minus(operating);

  const revenueBefore = sumMonths(revenueMonths, period.previous);
  const expensesBefore = sumMonths(expenseMonths, period.previous);
  const netProfitBefore = revenueBefore.minus(expensesBefore);

  return {
    period: periodDto(period),
    currentMonth,
    lines: [
      { key: "salesRevenue", kind: "income", amount: moneyString(revenue) },
      ...EXPENSE_LINES.map((l) => ({ key: l.key, kind: l.kind, amount: moneyString(spentOn(l.key)) })),
    ],
    revenue: moneyString(revenue),
    cost: moneyString(cost),
    operating: moneyString(operating),
    expenses: moneyString(expenses),
    grossProfit: moneyString(grossProfit),
    netProfit: moneyString(netProfit),
    marginPct: revenue.isZero() ? null : netProfit.dividedBy(revenue).times(100).round().toNumber(),
    previous: {
      start: period.previous.start,
      end: period.previous.end,
      revenue: moneyString(revenueBefore),
      expenses: moneyString(expensesBefore),
      netProfit: moneyString(netProfitBefore),
    },
    change: {
      revenue: changePct(revenue, revenueBefore),
      expenses: changePct(expenses, expensesBefore),
      netProfit: changePct(netProfit, netProfitBefore),
    },
    collected: moneyString(collected._sum.amount ?? ZERO),
    series: months.map((month) => ({
      month,
      revenue: moneyString(revenueMonths.get(month) ?? ZERO),
      expenses: moneyString(expenseMonths.get(month) ?? ZERO),
    })),
    topCustomers: top,
  };
}

// ---------------------------------------------------------------------------
// Receivables aging
// ---------------------------------------------------------------------------

const AGING_BUCKETS = ["notDue", "d1_30", "d31_60", "d60plus"] as const;
type AgingBucket = (typeof AGING_BUCKETS)[number];

type AgingRow = Record<AgingBucket | "total", Decimal> & {
  id: string;
  name: string;
  invoiceCount: number;
  maxDaysOverdue: number;
};

/**
 * What customers still owe on sent and partly paid invoices, by days past the
 * due date. Due today is not overdue yet (same rule as overdueWhere).
 */
export async function aging(companyId: string) {
  const asOf = businessToday();
  const raw = await prisma.$queryRaw<AgingRow[]>`
    WITH owed AS (
      SELECT i."customerId", i."total" - i."amountPaid" - i."credited" AS amount, ${toDate(asOf)}::date - i."dueDate" AS days
      FROM "invoices" i
      WHERE i."companyId" = ${companyId}
        AND i."status" IN ('sent', 'partial')
        AND i."total" > i."amountPaid" + i."credited"
    )
    SELECT c."id", c."name",
      COALESCE(SUM(o.amount) FILTER (WHERE o.days <= 0), 0) AS "notDue",
      COALESCE(SUM(o.amount) FILTER (WHERE o.days BETWEEN 1 AND 30), 0) AS "d1_30",
      COALESCE(SUM(o.amount) FILTER (WHERE o.days BETWEEN 31 AND 60), 0) AS "d31_60",
      COALESCE(SUM(o.amount) FILTER (WHERE o.days > 60), 0) AS "d60plus",
      SUM(o.amount) AS total,
      COUNT(*)::int AS "invoiceCount",
      GREATEST(MAX(o.days), 0)::int AS "maxDaysOverdue"
    FROM owed o
    JOIN "customers" c ON c."id" = o."customerId" AND c."companyId" = ${companyId}
    GROUP BY c."id", c."name"
    ORDER BY total DESC, c."name" ASC, c."id" ASC`;

  const rows = raw.map((r) => ({
    ...r,
    notDue: new Decimal(r.notDue),
    d1_30: new Decimal(r.d1_30),
    d31_60: new Decimal(r.d31_60),
    d60plus: new Decimal(r.d60plus),
    total: new Decimal(r.total),
  }));
  const add = (key: AgingBucket | "total") => rows.reduce((sum, r) => sum.plus(r[key]), ZERO);
  const total = add("total");

  return {
    asOf,
    buckets: AGING_BUCKETS.map((key) => ({ key, amount: moneyString(add(key)) })),
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      notDue: moneyString(r.notDue),
      d1_30: moneyString(r.d1_30),
      d31_60: moneyString(r.d31_60),
      d60plus: moneyString(r.d60plus),
      total: moneyString(r.total),
      invoiceCount: r.invoiceCount,
      maxDaysOverdue: r.maxDaysOverdue,
    })),
    total: moneyString(total),
    overdue: moneyString(total.minus(add("notDue"))),
    overdueCustomers: rows.filter((r) => r.total.gt(r.notDue)).length,
  };
}

// ---------------------------------------------------------------------------
// VAT return
// ---------------------------------------------------------------------------

/** Output VAT on issued invoices in the period: the stored VAT, never recomputed. */
export async function vatReport(companyId: string, periodKey: string | undefined) {
  const today = businessToday();
  const period = resolvePeriod(periodKey, today);
  const issued = {
    companyId,
    status: { in: ISSUED_STATUSES },
    issueDate: within(counted(period)),
  } satisfies Prisma.InvoiceWhereInput;

  const credits = (vatRate: Prisma.DecimalFilter | number) =>
    prisma.creditNote.aggregate({ where: { companyId, date: within(counted(period)), vatRate }, _sum: { subtotal: true, vat: true }, _count: true });
  const [taxable, exempt, used, company, purchases, taxableCredits, exemptCredits] = await prisma.$transaction([
    prisma.invoice.aggregate({ where: { ...issued, vatRate: { gt: 0 } }, _sum: { subtotal: true, vat: true }, _count: true }),
    // VAT off in the settings when the invoice was written (vatRate 0).
    prisma.invoice.aggregate({ where: { ...issued, vatRate: 0 }, _sum: { subtotal: true, vat: true }, _count: true }),
    // The rates the period's invoices were taxed at (more than one if it changed meanwhile).
    prisma.invoice.groupBy({ by: ["vatRate"], where: { ...issued, vatRate: { gt: 0 } }, orderBy: { vatRate: "asc" } }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { vatRate: true } }),
    // Input VAT: the VAT in the period's expenses (purchases with VAT on them).
    prisma.expense.aggregate({
      where: { companyId, date: within(counted(period)), vat: { gt: 0 } },
      _sum: { amount: true, vat: true },
      _count: true,
    }),
    credits({ gt: 0 }),
    credits(0),
  ]);
  const rates = used.map((r) => Number(r.vatRate));

  // Output VAT: on the period's invoices, less the VAT of its credit notes.
  const output = (taxable._sum.vat ?? ZERO).plus(exempt._sum.vat ?? ZERO).minus(taxableCredits._sum.vat ?? ZERO);
  const input = purchases._sum.vat ?? ZERO;

  return {
    period: periodDto(period),
    currentMonth: monthKey(today),
    // One rate: it; none yet: the company's rate now; several: null (see rates).
    rate: rates.length === 1 ? rates[0]! : rates.length === 0 ? Number(company.vatRate) : null,
    rates,
    output: moneyString(output),
    input: moneyString(input),
    due: moneyString(output.minus(input)),
    taxableSales: moneyString((taxable._sum.subtotal ?? ZERO).minus(taxableCredits._sum.subtotal ?? ZERO)),
    exemptSales: moneyString((exempt._sum.subtotal ?? ZERO).minus(exemptCredits._sum.subtotal ?? ZERO)),
    // Credit notes in the period (returns, discounts): already taken off the sales and VAT above.
    creditNotesCount: taxableCredits._count + exemptCredits._count,
    creditedVat: moneyString(taxableCredits._sum.vat ?? ZERO),
    // Purchases with VAT on them (the cost, VAT excluded), and how many.
    taxablePurchases: moneyString((purchases._sum.amount ?? ZERO).minus(input)),
    purchasesCount: purchases._count,
    invoicesCount: taxable._count + exempt._count,
    // The return is due by the end of the month after the period.
    filingDueDate: monthRange(period.end, 1).end,
  };
}

// ---------------------------------------------------------------------------
// Customer statement
// ---------------------------------------------------------------------------

/**
 * A customer's account for a period: the opening balance, every issued invoice
 * (debit) and payment (credit) in the period with a running balance, and the
 * closing balance. A pending cheque already lowers what is owed.
 */
const ORDER = { invoice: 0, creditNote: 1, refund: 2, payment: 3 } as const;

export async function statement(companyId: string, customerId: string, periodKey: string | undefined) {
  const today = businessToday();
  const period = resolvePeriod(periodKey, today);
  const issued = { companyId, customerId, status: { in: ISSUED_STATUSES } } satisfies Prisma.InvoiceWhereInput;
  const before = { lt: toDate(period.start) };

  // One snapshot, so the opening balance and the rows can't disagree with each other.
  const [customer, openingInvoiced, openingPaid, invoices, payments, openingCredited, creditNotes] = await prisma.$transaction(
    [
      prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, name: true } }),
      prisma.invoice.aggregate({ where: { ...issued, issueDate: before }, _sum: { total: true } }),
      // A payment is never dated before its invoice, so these are the payments on the invoices above.
      prisma.invoicePayment.aggregate({
        where: { companyId, date: before, invoice: issued, status: { not: "bounced" } },
        _sum: { amount: true },
      }),
      prisma.invoice.findMany({
        where: { ...issued, issueDate: within(counted(period)) },
        select: { id: true, number: true, numberPrefix: true, issueDate: true, total: true },
      }),
      prisma.invoicePayment.findMany({
        // A cheque that bounced paid nothing: it isn't on the statement.
        where: { companyId, date: within(counted(period)), invoice: issued, status: { not: "bounced" } },
        select: {
          id: true,
          number: true,
          date: true,
          amount: true,
          status: true,
          invoice: { select: { number: true, numberPrefix: true } },
        },
      }),
      prisma.creditNote.aggregate({ where: { companyId, customerId, date: before }, _sum: { total: true, refund: true } }),
      prisma.creditNote.findMany({
        where: { companyId, customerId, date: within(counted(period)) },
        select: { id: true, number: true, date: true, total: true, refund: true, invoice: { select: { number: true, numberPrefix: true } } },
      }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  if (!customer) throw notFound("Customer");

  const opening = (openingInvoiced._sum.total ?? ZERO)
    .minus(openingPaid._sum.amount ?? ZERO)
    .minus(openingCredited._sum.total ?? ZERO)
    .plus(openingCredited._sum.refund ?? ZERO);

  // By date; on the same day invoices come before payments; then by number.
  const rows = [
    ...invoices.map((i) => ({
      id: i.id,
      date: toIso(i.issueDate),
      type: "invoice" as const,
      number: i.number,
      ref: `${i.numberPrefix}${i.number}`,
      invoiceRef: null,
      amount: i.total,
      pending: false,
    })),
    ...payments.map((p) => ({
      id: p.id,
      date: toIso(p.date),
      type: "payment" as const,
      number: p.number,
      ref: paymentNumber(p.number),
      invoiceRef: `${p.invoice.numberPrefix}${p.invoice.number}`,
      amount: p.amount,
      pending: p.status === "pending",
    })),
    ...creditNotes.map((c) => ({
      id: c.id,
      date: toIso(c.date),
      type: "creditNote" as const,
      number: c.number,
      ref: creditNoteNumber(c.number),
      invoiceRef: `${c.invoice.numberPrefix}${c.invoice.number}`,
      amount: c.total,
      pending: false,
    })),
    ...creditNotes
      .filter((c) => c.refund.gt(0))
      .map((c) => ({
        id: `${c.id}-refund`,
        date: toIso(c.date),
        type: "refund" as const,
        number: c.number,
        ref: creditNoteNumber(c.number),
        invoiceRef: `${c.invoice.numberPrefix}${c.invoice.number}`,
        amount: c.refund,
        pending: false,
      })),
  ].sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      ORDER[a.type] - ORDER[b.type] ||
      a.number - b.number,
  );

  let balance = opening;
  let invoiced = ZERO;
  let paid = ZERO;
  let credited = ZERO;
  let refunded = ZERO;
  const txns = rows.map((row) => {
    if (row.type === "invoice") {
      invoiced = invoiced.plus(row.amount);
      balance = balance.plus(row.amount);
    } else if (row.type === "payment") {
      paid = paid.plus(row.amount);
      balance = balance.minus(row.amount);
    } else if (row.type === "creditNote") {
      credited = credited.plus(row.amount);
      balance = balance.minus(row.amount);
    } else {
      refunded = refunded.plus(row.amount);
      balance = balance.plus(row.amount);
    }
    return {
      id: row.id,
      date: row.date,
      type: row.type,
      ref: row.ref,
      invoiceRef: row.invoiceRef,
      amount: moneyString(row.amount),
      balance: moneyString(balance),
      pending: row.pending,
    };
  });

  return {
    customer,
    period: periodDto(period),
    currentMonth: monthKey(today),
    opening: moneyString(opening),
    invoiced: moneyString(invoiced),
    paid: moneyString(paid),
    credited: moneyString(credited),
    refunded: moneyString(refunded),
    closing: moneyString(opening.plus(invoiced).minus(paid).minus(credited).plus(refunded)),
    txns,
  };
}
