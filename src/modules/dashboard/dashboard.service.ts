import type { Role } from "../../generated/prisma/client.js";
import { businessToday, daysBetween, monthRange, toDate, toIso } from "../../lib/dates.js";
import { Decimal, moneyString, ZERO } from "../../lib/money.js";
import { can } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { invoiceStats, overdueWhere } from "../invoices/invoices.service.js";

const CHART_MONTHS = 6;
const ATTENTION_LIMIT = 5;

/** Change in percent, or null when there is nothing to compare with. */
const changePct = (now: Decimal, before: Decimal) =>
  before.isZero() ? null : now.minus(before).dividedBy(before).times(100).round().toNumber();

/**
 * Revenue per month: what was invoiced, before VAT (subtotal), on issued
 * invoices. Drafts and cancelled invoices don't count.
 */
async function revenueByMonth(companyId: string, from: string) {
  const rows = await prisma.$queryRaw<{ month: string; revenue: Decimal }[]>`
    SELECT to_char(date_trunc('month', "issueDate"), 'YYYY-MM') AS month, SUM("subtotal") AS revenue
    FROM "invoices"
    WHERE "companyId" = ${companyId}
      AND "status" IN ('sent', 'partial', 'paid')
      AND "issueDate" >= ${toDate(from)}::date
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.month, new Decimal(r.revenue)]));
}

export async function dashboard(companyId: string, role: Role) {
  const today = businessToday();
  const thisMonth = monthRange(today);

  const [stats, overdue, invoicesThisMonth] = await Promise.all([
    invoiceStats(companyId),
    prisma.invoice.findMany({
      where: { companyId, ...overdueWhere(today) },
      select: { id: true, number: true, numberPrefix: true, customerName: true, total: true, amountPaid: true, dueDate: true },
      orderBy: [{ dueDate: "asc" }, { number: "asc" }],
      take: ATTENTION_LIMIT,
    }),
    // For the plan card (invoices created this month, any status).
    prisma.invoice.count({
      where: { companyId, issueDate: { gte: toDate(thisMonth.start), lte: toDate(thisMonth.end) } },
    }),
  ]);

  // Most overdue first.
  const attention = overdue.map((i) => ({
    type: "invoiceOverdue" as const,
    id: i.id,
    number: i.number,
    displayNumber: `${i.numberPrefix}${i.number}`,
    customer: i.customerName,
    amount: moneyString(i.total.minus(i.amountPaid)),
    days: daysBetween(toIso(i.dueDate), today),
  }));

  const receivable = { outstanding: stats.outstanding, overdue: stats.overdue };

  // Revenue and profit are for the roles that may see financial reports.
  if (!can(role, "reports")) {
    return { financials: null, receivable, attention, invoicesThisMonth };
  }

  const firstMonth = monthRange(today, -(CHART_MONTHS - 1)).start;
  const revenue = await revenueByMonth(companyId, firstMonth);
  const chart = Array.from({ length: CHART_MONTHS }, (_, i) => {
    const month = monthRange(today, i - (CHART_MONTHS - 1)).start.slice(0, 7);
    // Expenses arrive with the expenses module; until then there are none.
    return { month, revenue: moneyString(revenue.get(month) ?? ZERO), expenses: "0.00" };
  });

  const revenueNow = revenue.get(thisMonth.start.slice(0, 7)) ?? ZERO;
  const revenueBefore = revenue.get(monthRange(today, -1).start.slice(0, 7)) ?? ZERO;
  const expensesNow = ZERO;

  return {
    financials: {
      revenue: moneyString(revenueNow),
      revenueChange: changePct(revenueNow, revenueBefore),
      expenses: moneyString(expensesNow),
      expensesChange: null,
      netProfit: moneyString(revenueNow.minus(expensesNow)),
      netProfitChange: changePct(revenueNow.minus(expensesNow), revenueBefore),
      chart,
    },
    receivable,
    attention,
    invoicesThisMonth,
  };
}
