import { Prisma, type InvoiceStatus } from "../../generated/prisma/client.js";
import { toDate } from "../../lib/dates.js";
import { Decimal } from "../../lib/money.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Issued invoices: sent, partly paid or paid. Drafts and cancelled (void)
 * invoices never count as revenue, VAT or sales anywhere.
 */
export const ISSUED_STATUSES: InvoiceStatus[] = ["sent", "partial", "paid"];
/** The same list for raw SQL: `"status" IN ${ISSUED_SQL}`. */
export const ISSUED_SQL = Prisma.sql`('sent', 'partial', 'paid')`;

/**
 * Revenue per month ("YYYY-MM"): what was invoiced before VAT (subtotal) on
 * issued invoices, by issue date, from `range.start` to `range.end` inclusive.
 * The dashboard, the expenses page and the reports all use this, so their
 * revenue figures always agree.
 */
export async function revenueByMonth(companyId: string, range: { start: string; end: string }) {
  const rows = await prisma.$queryRaw<{ month: string; revenue: Decimal }[]>`
    SELECT to_char(date_trunc('month', "issueDate"), 'YYYY-MM') AS month, SUM("subtotal") AS revenue
    FROM "invoices"
    WHERE "companyId" = ${companyId}
      AND "status" IN ${ISSUED_SQL}
      AND "issueDate" BETWEEN ${toDate(range.start)}::date AND ${toDate(range.end)}::date
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.month, new Decimal(r.revenue)]));
}
