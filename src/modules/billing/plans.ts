// The plans: prices and what each allows. The one place to change them.
import type { PlanId, Prisma } from "../../generated/prisma/client.js";
import { addDays, businessToday, daysBetween, monthRange, toDate } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";

type Db = Prisma.TransactionClient;

export type Plan = {
  id: PlanId;
  /** Per month, in EGP (what the customer pays). */
  price: number;
  /** Team members, the owner included. */
  users: number;
  /** Invoices made in a calendar month (Cairo); null = no limit. */
  invoicesPerMonth: number | null;
  /** Recurring invoice templates. */
  recurring: boolean;
  /** Employees and payroll. */
  payroll: boolean;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    price: 0,
    users: 1,
    invoicesPerMonth: 10,
    recurring: false,
    payroll: false,
  },
  pro: {
    id: "pro",
    price: 1200,
    users: 10,
    invoicesPerMonth: null,
    recurring: true,
    payroll: true,
  },
  business: {
    id: "business",
    price: 2500,
    users: 50,
    invoicesPerMonth: null,
    recurring: true,
    payroll: true,
  },
};

/** Cheapest first: a plan later in the list is an upgrade. */
export const PLAN_ORDER: PlanId[] = ["free", "pro", "business"];
export const isHigher = (a: PlanId, b: PlanId) => PLAN_ORDER.indexOf(a) > PLAN_ORDER.indexOf(b);

/** The plan in force: the paid one while it is active (or being retried), else free. */
export async function currentPlan(db: Db, companyId: string): Promise<Plan> {
  const subscription = await db.subscription.findUnique({
    where: { companyId },
    select: { plan: true, status: true },
  });
  return PLANS[subscription && subscription.status !== "ended" ? subscription.plan : "free"];
}

/**
 * When a Cairo calendar day starts, as a moment in time (Cairo is UTC+2, or +3
 * in summer time).
 */
export function businessDayStart(iso: string) {
  const midnightUtc = toDate(iso);
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Africa/Cairo",
      timeZoneName: "longOffset",
    })
      .formatToParts(midnightUtc)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT+02:00";
  const match = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const minutes = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return new Date(midnightUtc.getTime() - minutes * 60_000);
}

/** Invoices made this calendar month (Cairo), by when they were made, not their date. */
export function invoicesMadeThisMonth(db: Db, companyId: string, today = businessToday()) {
  const { start, end } = monthRange(today);
  return db.invoice.count({
    where: {
      companyId,
      createdAt: {
        gte: businessDayStart(start),
        lt: businessDayStart(addDays(end, 1)),
      },
    },
  });
}

const planLimit = (code: string, message: string, details: Record<string, unknown>) =>
  new AppError(402, code, message, details);

/** Before making an invoice by hand. Call it in the transaction that locks the company row. */
export async function checkInvoiceLimit(db: Db, companyId: string) {
  const plan = await currentPlan(db, companyId);
  if (plan.invoicesPerMonth === null) return;
  if ((await invoicesMadeThisMonth(db, companyId)) >= plan.invoicesPerMonth) {
    throw planLimit("PLAN_LIMIT_INVOICES", "This plan's invoices for the month are used up", {
      plan: plan.id,
      limit: plan.invoicesPerMonth,
    });
  }
}

/** Before inviting someone: members and pending invitations count. */
export async function checkUserLimit(db: Db, companyId: string) {
  const plan = await currentPlan(db, companyId);
  // One after the other: this may run inside a transaction (one connection).
  const members = await db.user.count({ where: { companyId } });
  const invited = await db.invitation.count({
    where: {
      companyId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (members + invited >= plan.users) {
    throw planLimit("PLAN_LIMIT_USERS", "This plan's team is full", {
      plan: plan.id,
      limit: plan.users,
    });
  }
}

/** Before making or restarting a recurring invoice template. */
export async function checkRecurringAllowed(db: Db, companyId: string) {
  const plan = await currentPlan(db, companyId);
  if (!plan.recurring) {
    throw planLimit("PLAN_FEATURE", "Recurring invoices need a paid plan", {
      plan: plan.id,
      feature: "recurring",
    });
  }
}

/** Employees and payroll are for the paid plans (the data stays if the plan ends; it opens again on upgrade). */
export async function checkPayrollAllowed(db: Db, companyId: string) {
  const plan = await currentPlan(db, companyId);
  if (!plan.payroll) {
    throw planLimit("PLAN_FEATURE", "Employees and payroll need a paid plan", { plan: plan.id, feature: "payroll" });
  }
}

/** The share of a period still to come (for an upgrade in the middle of it). */
export function remainingShare(periodStart: string, periodEnd: string, today = businessToday()) {
  const total = daysBetween(periodStart, periodEnd);
  const left = Math.max(0, daysBetween(today, periodEnd));
  return total > 0 ? Math.min(1, left / total) : 0;
}
