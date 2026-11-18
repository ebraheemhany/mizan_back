import type { Role } from "../../generated/prisma/client.js";
import { businessToday, daysBetween, monthRange, toDate, toIso } from "../../lib/dates.js";
import { moneyString, ZERO } from "../../lib/money.js";
import { can } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { changePct, expensesByMonth } from "../expenses/expenses.service.js";
import { invoiceStats, overdueWhere } from "../invoices/invoices.service.js";
import { revenueByMonth } from "../reports/revenue.js";

const CHART_MONTHS = 6;
const ATTENTION_LIMIT = 5;

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
