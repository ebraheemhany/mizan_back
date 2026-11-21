import type { Role } from "../../generated/prisma/client.js";
import { businessToday, daysBetween, monthRange, toDate, toIso } from "../../lib/dates.js";
import { moneyString, ZERO } from "../../lib/money.js";
import { can } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { changePct, expensesByMonth } from "../expenses/expenses.service.js";
import { STALE_DAYS } from "../deals/deals.service.js";
import { invoiceStats, overdueWhere } from "../invoices/invoices.service.js";
import { revenueByMonth } from "../reports/revenue.js";

const CHART_MONTHS = 6;
const ATTENTION_LIMIT = 5;
/** Deals with no activity for STALE_DAYS days or more, the longest-quiet first. */
const STALE_DEALS_LIMIT = 3;

export async function dashboard(companyId: string, role: Role) {
  const today = businessToday();
  const thisMonth = monthRange(today);

  const [stats, overdue, invoicesThisMonth, quietDeals] = await Promise.all([
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
    // Open deals quiet for a while (a day more than needed, then counted in Cairo days below).
    prisma.deal.findMany({
      where: {
        companyId,
        lostOn: null,
        stage: { not: "won" },
        lastActivityAt: { lt: new Date(Date.now() - (STALE_DAYS - 1) * 86_400_000) },
      },
      select: { id: true, title: true, value: true, lastActivityAt: true, customer: { select: { name: true } } },
      orderBy: { lastActivityAt: "asc" },
      take: STALE_DEALS_LIMIT * 2,
    }),
  ]);

  // Most overdue first.
  const attention: {
    type: "invoiceOverdue" | "staleDeal";
    id: string;
    number: number | null;
    displayNumber: string;
    customer: string;
    amount: string;
    days: number;
  }[] = overdue.map((i) => ({
    type: "invoiceOverdue" as const,
    id: i.id,
    number: i.number,
    displayNumber: `${i.numberPrefix}${i.number}`,
    customer: i.customerName,
    amount: moneyString(i.total.minus(i.amountPaid)),
    days: daysBetween(toIso(i.dueDate), today),
  }));
  for (const deal of quietDeals) {
    const days = daysBetween(businessToday(deal.lastActivityAt), today);
    if (days < STALE_DAYS || attention.filter((a) => a.type === "staleDeal").length >= STALE_DEALS_LIMIT) continue;
    attention.push({
      type: "staleDeal",
      id: deal.id,
      number: null,
      displayNumber: deal.title,
      customer: deal.customer.name,
      amount: moneyString(deal.value),
      days,
    });
  }

  const receivable = { outstanding: stats.outstanding, overdue: stats.overdue };

  // Revenue and profit are for the roles that may see financial reports.
  if (!can(role, "reports")) {
    return { financials: null, receivable, attention, invoicesThisMonth };
  }

  const firstMonth = monthRange(today, -(CHART_MONTHS - 1)).start;
  const [revenue, expenses] = await Promise.all([
    revenueByMonth(companyId, { start: firstMonth, end: thisMonth.end }),
    expensesByMonth(companyId, firstMonth),
  ]);
  const chart = Array.from({ length: CHART_MONTHS }, (_, i) => {
    const month = monthRange(today, i - (CHART_MONTHS - 1)).start.slice(0, 7);
    return {
      month,
      revenue: moneyString(revenue.get(month) ?? ZERO),
      expenses: moneyString(expenses.get(month) ?? ZERO),
    };
  });

  const nowKey = thisMonth.start.slice(0, 7);
  const beforeKey = monthRange(today, -1).start.slice(0, 7);
  const revenueNow = revenue.get(nowKey) ?? ZERO;
  const revenueBefore = revenue.get(beforeKey) ?? ZERO;
  const expensesNow = expenses.get(nowKey) ?? ZERO;
  const expensesBefore = expenses.get(beforeKey) ?? ZERO;

  return {
    financials: {
      revenue: moneyString(revenueNow),
      revenueChange: changePct(revenueNow, revenueBefore),
      expenses: moneyString(expensesNow),
      expensesChange: changePct(expensesNow, expensesBefore),
      netProfit: moneyString(revenueNow.minus(expensesNow)),
      // Profit compared with last month's profit (not last month's revenue).
      netProfitChange: changePct(revenueNow.minus(expensesNow), revenueBefore.minus(expensesBefore)),
      chart,
    },
    receivable,
    attention,
    invoicesThisMonth,
  };
}
