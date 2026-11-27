// Mizan's own view of the platform: every company, its plan, and how much it uses Mizan.
// Counts and dates only. What is inside a company (its customers, amounts, documents)
// stays its own business, so none of it is read here.
import { Prisma, type BillingPaymentKind, type PlanId } from "../../generated/prisma/client.js";
import { addDays, addMonths, businessToday, monthRange, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { paymentNumber } from "../billing/billing.service.js";
import { businessDayStart, PLANS } from "../billing/plans.js";
import { ADMIN_PAGE_SIZE, type ActivateSubscriptionInput, type ListCompaniesQuery } from "./admin.schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** When this Cairo month started (plan limits count invoices from then). */
function monthStart() {
  return businessDayStart(monthRange(businessToday()).start);
}

const notFound = () => new AppError(404, "NOT_FOUND", "Company not found");

/** A subscription that still gives its plan (paid, or a renewal being retried). */
const PAYING: Prisma.SubscriptionWhereInput = { status: { in: ["active", "pastDue"] } };

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getOverview() {
  const now = Date.now();
  const since7 = new Date(now - 7 * DAY_MS);
  const since30 = new Date(now - 30 * DAY_MS);
  const startOfMonth = monthStart();
  // Someone signed in (or the app refreshed their session) in that window.
  const activeSince = (since: Date): Prisma.CompanyWhereInput => ({
    users: { some: { refreshTokens: { some: { createdAt: { gte: since } } } } },
  });

  const [companies, newThisMonth, newLast7Days, users, active7, active30, subscriptions, revenueMonth, revenueTotal, desktop] =
    await Promise.all([
      prisma.company.count(),
      prisma.company.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.company.count({ where: { createdAt: { gte: since7 } } }),
      prisma.user.count(),
      prisma.company.count({ where: activeSince(since7) }),
      prisma.company.count({ where: activeSince(since30) }),
      prisma.subscription.findMany({ where: PAYING, select: { plan: true, status: true, cancelAtPeriodEnd: true } }),
      prisma.billingPayment.aggregate({ _sum: { amount: true }, where: { status: "paid", paidAt: { gte: startOfMonth } } }),
      prisma.billingPayment.aggregate({ _sum: { amount: true }, where: { status: "paid" } }),
      prisma.auditEvent.findMany({
        where: { event: "signedInDesktop", createdAt: { gte: since30 } },
        distinct: ["companyId"],
        select: { companyId: true },
      }),
    ]);

  const byPlan: Record<PlanId, number> = { free: 0, pro: 0, business: 0 };
  let monthlyRecurring = 0;
  for (const s of subscriptions) {
    byPlan[s.plan] += 1;
    monthlyRecurring += PLANS[s.plan].price;
  }
  byPlan.free = companies - byPlan.pro - byPlan.business;

  return {
    companies: { total: companies, newThisMonth, newLast7Days, active7Days: active7, active30Days: active30 },
    users,
    plans: byPlan,
    subscriptions: {
      paying: subscriptions.length,
      pastDue: subscriptions.filter((s) => s.status === "pastDue").length,
      cancelling: subscriptions.filter((s) => s.cancelAtPeriodEnd).length,
    },
    // Mizan's own prices are in EGP.
    revenue: {
      currency: "EGP",
      monthlyRecurring: monthlyRecurring.toFixed(2),
      thisMonth: (revenueMonth._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      total: (revenueTotal._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
    },
    desktopCompanies30Days: desktop.length,
  };
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

type CompanyRow = {
  id: string;
  name: string;
  createdAt: Date;
  currency: string;
  plan: PlanId;
  subscriptionStatus: "active" | "pastDue" | "ended" | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean | null;
  ownerName: string | null;
  ownerEmail: string | null;
  users: number;
  customers: number;
  invoices: number;
  invoicesThisMonth: number;
  lastActiveAt: Date | null;
  total: number;
};

const ORDER: Record<ListCompaniesQuery["sort"], Prisma.Sql> = {
  newest: Prisma.sql`"createdAt" DESC`,
  oldest: Prisma.sql`"createdAt" ASC`,
  active: Prisma.sql`"lastActiveAt" DESC NULLS LAST, "createdAt" DESC`,
  usage: Prisma.sql`"invoicesThisMonth" DESC, invoices DESC, "createdAt" DESC`,
  name: Prisma.sql`lower(name) ASC`,
};

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function listCompanies(query: ListCompaniesQuery) {
  const q = query.q ? `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const plan = query.plan === "all" ? null : query.plan;
  const offset = (query.page - 1) * ADMIN_PAGE_SIZE;

  // One row per company with its counts. Last activity: a session refreshed or anything
  // done that the activity log keeps, whichever is later.
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<CompanyRow[]>`
      WITH base AS (
        SELECT c.id, c.name, c."createdAt", c.currency::text AS currency,
          CASE WHEN s.status IS NULL OR s.status = 'ended' THEN 'free' ELSE s.plan::text END AS plan,
          s.status::text AS "subscriptionStatus", s."currentPeriodEnd", s."cancelAtPeriodEnd",
          o."fullName" AS "ownerName", o.email AS "ownerEmail",
          (SELECT count(*)::int FROM users u WHERE u."companyId" = c.id) AS users,
          (SELECT count(*)::int FROM customers x WHERE x."companyId" = c.id) AS customers,
          (SELECT count(*)::int FROM invoices x WHERE x."companyId" = c.id) AS invoices,
          (SELECT count(*)::int FROM invoices x WHERE x."companyId" = c.id AND x."createdAt" >= ${monthStart()}) AS "invoicesThisMonth",
          GREATEST(
            (SELECT max(rt."createdAt") FROM refresh_tokens rt JOIN users u ON u.id = rt."userId" WHERE u."companyId" = c.id),
            (SELECT max(a."createdAt") FROM audit_events a WHERE a."companyId" = c.id)
          ) AS "lastActiveAt"
        FROM companies c
        LEFT JOIN subscriptions s ON s."companyId" = c.id
        LEFT JOIN LATERAL (
          SELECT u."fullName", u.email FROM users u
          WHERE u."companyId" = c.id AND u.role = 'owner'
          ORDER BY u."createdAt" LIMIT 1
        ) o ON true
      )
      SELECT *, count(*) OVER()::int AS total FROM base
      WHERE (${q}::text IS NULL OR name ILIKE ${q} OR "ownerEmail" ILIKE ${q} OR "ownerName" ILIKE ${q})
        AND (${plan}::text IS NULL OR plan = ${plan})
      ORDER BY ${ORDER[query.sort]}
      LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${offset}`,
    prisma.$queryRaw<{ plan: PlanId; count: number }[]>`
      SELECT CASE WHEN s.status IS NULL OR s.status = 'ended' THEN 'free' ELSE s.plan::text END AS plan,
        count(*)::int AS count
      FROM companies c LEFT JOIN subscriptions s ON s."companyId" = c.id
      GROUP BY 1`,
  ]);

  const tabs: Record<"all" | PlanId, number> = { all: 0, free: 0, pro: 0, business: 0 };
  for (const row of counts) {
    tabs[row.plan] = row.count;
    tabs.all += row.count;
  }

  return {
    companies: rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      currency: r.currency,
      owner: r.ownerEmail ? { name: r.ownerName, email: r.ownerEmail } : null,
      plan: r.plan,
      subscription: r.subscriptionStatus
        ? { status: r.subscriptionStatus, currentPeriodEnd: isoDate(r.currentPeriodEnd), cancelAtPeriodEnd: !!r.cancelAtPeriodEnd }
        : null,
      users: r.users,
      customers: r.customers,
      invoices: r.invoices,
      invoicesThisMonth: r.invoicesThisMonth,
      lastActiveAt: r.lastActiveAt,
    })),
    total: rows[0]?.total ?? 0,
    page: query.page,
    pageSize: ADMIN_PAGE_SIZE,
    counts: tabs,
  };
}

export async function getCompany(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const company = await prisma.company.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      currency: true,
      phone: true,
      address: true,
      taxNumber: true,
      commercialRegister: true,
      subscription: {
        select: {
          plan: true,
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          nextPlan: true,
          cardBrand: true,
          cardMasked: true,
          renewalAttempts: true,
        },
      },
    },
  });
  if (!company) throw notFound();

  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const where = { companyId: id };
  const [members, counts, invoicesThisMonth, billing, activity] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        createdAt: true,
        emailVerifiedAt: true,
        googleId: true,
        passwordHash: true,
      },
    }),
    Promise.all([
      prisma.customer.count({ where }),
      prisma.product.count({ where }),
      prisma.invoice.count({ where }),
      prisma.quote.count({ where }),
      prisma.invoicePayment.count({ where }),
      prisma.expense.count({ where }),
      prisma.recurringInvoice.count({ where }),
      prisma.deal.count({ where }),
      prisma.task.count({ where }),
      prisma.employee.count({ where }),
    ]),
    prisma.invoice.count({ where: { companyId: id, createdAt: { gte: monthStart() } } }),
    prisma.billingPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        number: true,
        kind: true,
        plan: true,
        amount: true,
        currency: true,
        status: true,
        automatic: true,
        manual: true,
        note: true,
        createdAt: true,
        paidAt: true,
        periodStart: true,
        periodEnd: true,
      },
    }),
    // What the company did on each of the last 30 days (Cairo dates), from its activity log.
    prisma.$queryRaw<{ day: string; count: number }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM audit_events WHERE "companyId" = ${id} AND "createdAt" >= ${since30}
      GROUP BY 1`,
  ]);

  const memberIds = members.map((m) => m.id);
  const [lastSessions, desktopUsers] = await Promise.all([
    prisma.refreshToken.groupBy({ by: ["userId"], where: { userId: { in: memberIds } }, _max: { createdAt: true } }),
    prisma.auditEvent.findMany({
      where: { companyId: id, event: "signedInDesktop" },
      distinct: ["userId"],
      select: { userId: true },
    }),
  ]);
  const lastSeen = new Map(lastSessions.map((s) => [s.userId, s._max.createdAt]));
  const onDesktop = new Set(desktopUsers.map((d) => d.userId));

  const [customers, products, invoices, quotes, payments, expenses, recurring, deals, tasks, employees] = counts;
  const subscription = company.subscription;
  const planId: PlanId = subscription && subscription.status !== "ended" ? subscription.plan : "free";
  const plan = PLANS[planId];
  const today = businessToday();

  return {
    company: {
      id: company.id,
      name: company.name,
      createdAt: company.createdAt,
      currency: company.currency,
      phone: company.phone,
      address: company.address,
      taxNumber: company.taxNumber,
      commercialRegister: company.commercialRegister,
    },
    plan: {
      id: planId,
      price: plan.price,
      users: { used: members.length, limit: plan.users },
      invoicesThisMonth: { used: invoicesThisMonth, limit: plan.invoicesPerMonth },
    },
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodStart: isoDate(subscription.currentPeriodStart),
          currentPeriodEnd: isoDate(subscription.currentPeriodEnd),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          nextPlan: subscription.nextPlan,
          card: subscription.cardMasked ? { brand: subscription.cardBrand, masked: subscription.cardMasked } : null,
          renewalAttempts: subscription.renewalAttempts,
        }
      : null,
    members: members.map((m) => ({
      id: m.id,
      fullName: m.fullName,
      email: m.email,
      role: m.role,
      createdAt: m.createdAt,
      emailVerified: m.emailVerifiedAt !== null,
      google: m.googleId !== null,
      password: m.passwordHash !== null,
      lastActiveAt: lastSeen.get(m.id) ?? null,
      desktop: onDesktop.has(m.id),
    })),
    usage: { customers, products, invoices, invoicesThisMonth, quotes, payments, expenses, recurring, deals, tasks, employees },
    activity: {
      // Oldest first, a zero for a quiet day.
      days: Array.from({ length: 30 }, (_, i) => {
        const day = addDays(today, i - 29);
        return { day, count: activity.find((a) => a.day === day)?.count ?? 0 };
      }),
    },
    billing: billing.map((b) => ({
      number: paymentNumber(b.number),
      kind: b.kind,
      plan: b.plan,
      amount: b.amount.toFixed(2),
      currency: b.currency,
      status: b.status,
      automatic: b.automatic,
      manual: b.manual,
      note: b.note,
      createdAt: b.createdAt,
      paidAt: b.paidAt,
      periodStart: isoDate(b.periodStart),
      periodEnd: isoDate(b.periodEnd),
    })),
  };
}

// ---------------------------------------------------------------------------
// Activating a plan paid outside Paymob
// ---------------------------------------------------------------------------

/**
 * Records a plan the company paid for outside Paymob (cash, a transfer), the way a paid
 * checkout would: the same plan, still running or waiting for its renewal, is extended
 * from the end of its paid period; another plan, or a company on the free plan, starts a
 * new period today. A saved card stays, so the plan renews on it afterwards as usual.
 */
export async function activateSubscription(adminId: string, companyId: string, input: ActivateSubscriptionInput) {
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw notFound();

  await prisma.$transaction(async (tx) => {
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw notFound();
    // The renewal job, a Paymob callback and this can't cross.
    await tx.$queryRaw`SELECT 1 FROM "subscriptions" WHERE "companyId" = ${companyId} FOR UPDATE`;
    const sub = await tx.subscription.findUnique({ where: { companyId } });

    const today = businessToday();
    const running = sub !== null && sub.status !== "ended";
    const extend = running && sub.plan === input.plan;
    let kind: BillingPaymentKind;
    let periodStart: string;
    let periodEnd: string;
    if (extend) {
      // Follows on from what is already paid (for a renewal not paid yet, from when it was due).
      kind = "renewal";
      periodStart = toIso(sub.currentPeriodEnd);
      periodEnd = addMonths(periodStart, input.months);
    } else {
      kind = "subscribe";
      periodStart = today;
      periodEnd = addMonths(today, input.months);
    }

    const data = {
      plan: input.plan,
      status: "active" as const,
      // An extension of a running period keeps its start (it is one longer paid period).
      currentPeriodStart: toDate(extend && sub.status === "active" ? toIso(sub.currentPeriodStart) : periodStart),
      currentPeriodEnd: toDate(periodEnd),
      cancelAtPeriodEnd: false,
      nextPlan: null,
      renewalAttempts: 0,
      nextAttemptAt: null,
    };
    await tx.subscription.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });

    const payment = await tx.billingPayment.create({
      data: {
        companyId,
        kind,
        plan: input.plan,
        amount: new Prisma.Decimal(input.amount),
        currency: "EGP",
        status: "paid",
        manual: true,
        note: input.note || null,
        periodStart: toDate(periodStart),
        periodEnd: toDate(periodEnd),
        createdById: adminId,
        paidAt: new Date(),
      },
    });

    // The company's own activity log says Mizan did it (not one of its members).
    await audit(
      tx,
      companyId,
      {
        action: "settings",
        event: "subscriptionActivatedByMizan",
        item: { type: "subscription", ref: paymentNumber(payment.number) },
        values: { plan: input.plan, amount: new Prisma.Decimal(input.amount).toFixed(2), through: periodEnd },
      },
      { id: null, name: null },
    );
  });

  return getCompany(companyId);
}
