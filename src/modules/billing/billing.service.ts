// Subscriptions: the plan in force, paying for one (Paymob's checkout), changing
// or cancelling it, and the monthly renewal charged to the saved card.
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type {
  BillingPayment,
  BillingPaymentKind,
  PlanId,
  Prisma,
  Subscription,
} from "../../generated/prisma/client.js";
import { addDays, addMonths, businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { Decimal, moneyString } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit, type Who } from "../audit/audit.service.js";
import type { Locale } from "../email/templates.js";
import { gateway, paymobConfigured, type ChargeResult, type Payer } from "./paymob.js";
import { invoicesMadeThisMonth, isHigher, PLAN_ORDER, PLANS, remainingShare } from "./plans.js";

type Db = Prisma.TransactionClient;
type Actor = { id: string; companyId: string };

/** How long an unpaid renewal keeps the plan while it is retried. */
export const GRACE_DAYS = 7;
/** Automatic tries for one renewal (a day apart). */
export const MAX_RENEWAL_ATTEMPTS = 3;
/** A checkout nobody finished is given up after this (Paymob's page works for an hour). */
const CHECKOUT_TTL_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Paymob confirms payments: the audit log shows them as the system's doing. */
const SYSTEM: Who = { id: null, name: null };

export const paymentNumber = (n: number) => `SUB-${String(n).padStart(5, "0")}`;
const cents = (amount: Decimal) => Number(amount.times(100).toFixed(0));
const price = (plan: PlanId) => new Decimal(PLANS[plan].price);

/** Holds the company's subscription row until the transaction ends (the job, a callback and a click can't cross). */
async function lockSubscription(tx: Db, companyId: string) {
  await tx.$queryRaw`SELECT 1 FROM "subscriptions" WHERE "companyId" = ${companyId} FOR UPDATE`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function subscriptionDto(sub: Subscription) {
  const periodEnd = toIso(sub.currentPeriodEnd);
  return {
    status: sub.status,
    periodStart: toIso(sub.currentPeriodStart),
    periodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    nextPlan: sub.nextPlan,
    card: sub.cardMasked ? { masked: sub.cardMasked, brand: sub.cardBrand } : null,
    /** pastDue: the plan stops on this day unless the renewal is paid. */
    graceEndsOn: sub.status === "pastDue" ? addDays(periodEnd, GRACE_DAYS) : null,
  };
}

/** The plan, its limits and what is used of them (every role sees this). */
export async function getBilling(companyId: string) {
  const sub = await prisma.subscription.findUnique({ where: { companyId } });
  const active = sub && sub.status !== "ended" ? sub : null;
  const plan = PLANS[active?.plan ?? "free"];
  const users = await prisma.user.count({ where: { companyId } });
  const invited = await prisma.invitation.count({
    where: {
      companyId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  const invoices = await invoicesMadeThisMonth(prisma, companyId);
  return {
    plan: plan.id,
    subscription: active ? subscriptionDto(active) : null,
    usage: {
      users: users + invited,
      usersLimit: plan.users,
      invoicesThisMonth: invoices,
      invoicesLimit: plan.invoicesPerMonth,
    },
    plans: PLAN_ORDER.map((id) => PLANS[id]),
    /** No Paymob keys: payments go through the local test checkout. */
    testMode: !paymobConfigured(),
  };
}

function paymentDto(p: BillingPayment) {
  return {
    id: p.id,
    number: paymentNumber(p.number),
    kind: p.kind,
    plan: p.plan,
    amount: moneyString(p.amount),
    currency: p.currency,
    status: p.status,
    automatic: p.automatic,
    periodStart: p.periodStart ? toIso(p.periodStart) : null,
    periodEnd: p.periodEnd ? toIso(p.periodEnd) : null,
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
  };
}

export async function listPayments(companyId: string) {
  const rows = await prisma.billingPayment.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(paymentDto);
}

export async function getPayment(companyId: string, id: string) {
  const row = await prisma.billingPayment.findFirst({
    where: { id, companyId },
  });
  if (!row) throw notFound("Payment");
  return paymentDto(row);
}

// ---------------------------------------------------------------------------
// Paying: a new plan, a higher one, or a renewal that wasn't charged
// ---------------------------------------------------------------------------

/** Who pays, as Paymob's billing data wants it. */
async function payerFor(userId: string): Promise<Payer> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      fullName: true,
      email: true,
      company: { select: { phone: true } },
    },
  });
  const [firstName, ...rest] = user.fullName.trim().split(/\s+/);
  return {
    firstName: firstName || "NA",
    lastName: rest.join(" ") || "NA",
    email: user.email,
    phone: user.company.phone || "NA",
  };
}

/** What paying for `plan` now means, and how much it costs. */
function checkoutFor(
  sub: Subscription | null,
  plan: PlanId,
  today: string,
): { kind: BillingPaymentKind; amount: Decimal } {
  if (!sub || sub.status === "ended") return { kind: "subscribe", amount: price(plan) };
  // The renewal wasn't paid: paying now starts a new month (on any paid plan).
  if (sub.status === "pastDue") return { kind: "renewal", amount: price(plan) };
  if (plan === sub.plan) throw new AppError(409, "ALREADY_ON_PLAN", "This is already the company's plan");
  if (!isHigher(plan, sub.plan)) {
    throw new AppError(409, "DOWNGRADE_AT_PERIOD_END", "A lower plan starts at the end of the period");
  }
  const share = remainingShare(toIso(sub.currentPeriodStart), toIso(sub.currentPeriodEnd), today);
  // The period is over (the renewal hasn't run yet): a full month of the new plan.
  if (share <= 0) return { kind: "renewal", amount: price(plan) };
  // The difference for the days left, never under 1 EGP.
  const difference = price(plan).minus(price(sub.plan)).times(share).toDecimalPlaces(2);
  return { kind: "upgrade", amount: Decimal.max(difference, new Decimal(1)) };
}

/** Starts paying for a plan: returns the page to send the owner to. */
export async function startCheckout(actor: Actor, plan: PlanId, locale: Locale) {
  const pay = gateway(); // Refuses early when payments aren't set up.
  const sub = await prisma.subscription.findUnique({
    where: { companyId: actor.companyId },
  });
  const { kind, amount } = checkoutFor(sub, plan, businessToday());

  const id = randomUUID();
  const returnUrl = new URL(`/${locale}/billing/return?payment=${id}`, config.APP_URL).toString();
  await prisma.billingPayment.create({
    data: {
      id,
      companyId: actor.companyId,
      kind,
      plan,
      amount,
      returnUrl,
      createdById: actor.id,
    },
  });
  try {
    const checkout = await pay.createCheckout({
      reference: id,
      amountCents: cents(amount),
      description: `Mizan ${plan} plan`,
      payer: await payerFor(actor.id),
      returnUrl,
    });
    await prisma.billingPayment.update({
      where: { id },
      data: { gatewayOrderId: checkout.orderId },
    });
    return {
      paymentId: id,
      url: checkout.url,
      amount: moneyString(amount),
      kind,
    };
  } catch (err) {
    await prisma.billingPayment.update({
      where: { id },
      data: { status: "failed", failureReason: "Checkout not opened" },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Settling a payment (Paymob's callback, a renewal's answer, the test checkout)
// ---------------------------------------------------------------------------

export type Outcome = {
  paid: boolean;
  transactionId?: string | undefined;
  reason?: string | undefined;
  /** What Paymob says was paid (checked against the price). */
  amountCents?: number | undefined;
  /** Paymob's order the callback is about. */
  orderId?: string | undefined;
};

/**
 * Records how a payment ended and applies it to the subscription. Settling twice
 * (the callback and the charge's own answer) does nothing the second time.
 */
export async function settlePayment(paymentId: string, outcome: Outcome) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billingPayment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) return null;
    // A callback about another order than the one this payment opened.
    if (outcome.orderId !== undefined && payment.gatewayOrderId !== outcome.orderId) {
      logger.warn({ paymentId, orderId: outcome.orderId }, "Payment callback for another order: ignored");
      return payment.status;
    }
    await lockSubscription(tx, payment.companyId);

    let paid = outcome.paid;
    let reason = outcome.reason;
    // Paid, but not what was asked: the plan isn't given.
    if (paid && outcome.amountCents !== undefined && outcome.amountCents !== cents(payment.amount)) {
      logger.error(
        {
          paymentId,
          got: outcome.amountCents,
          expected: cents(payment.amount),
        },
        "Paid amount differs",
      );
      paid = false;
      reason = "Amount differs from the price";
    }
    const { count } = await tx.billingPayment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: paid
        ? {
            status: "paid",
            paidAt: new Date(),
            gatewayTransactionId: outcome.transactionId ?? null,
          }
        : {
            status: "failed",
            failureReason: (reason ?? "Declined").slice(0, 200),
            gatewayTransactionId: outcome.transactionId ?? null,
          },
    });
    if (count === 0) return (await tx.billingPayment.findUniqueOrThrow({ where: { id: payment.id } })).status;

    if (paid) await applyPaid(tx, payment);
    else if (payment.automatic) await applyFailedRenewal(tx, payment, reason);
    return paid ? "paid" : "failed";
  });
}

async function applyPaid(tx: Db, payment: BillingPayment) {
  const today = businessToday();
  const sub = await tx.subscription.findUnique({
    where: { companyId: payment.companyId },
  });
  const card = payment.cardToken
    ? {
        cardToken: payment.cardToken,
        cardMasked: payment.cardMasked,
        cardBrand: payment.cardBrand,
      }
    : {};
  let periodStart: string;
  let periodEnd: string;
  let event: string;

  if (payment.kind === "upgrade" && sub?.status === "active") {
    // The same period, on the higher plan.
    periodStart = today;
    periodEnd = toIso(sub.currentPeriodEnd);
    await tx.subscription.update({
      where: { companyId: payment.companyId },
      data: {
        plan: payment.plan,
        nextPlan: null,
        cancelAtPeriodEnd: false,
        ...card,
      },
    });
    event = "planUpgraded";
  } else if (payment.automatic && sub && sub.status !== "ended") {
    // The saved card paid the next month: it follows on from the last one.
    periodStart = toIso(sub.currentPeriodEnd);
    periodEnd = addMonths(periodStart, 1);
    await tx.subscription.update({
      where: { companyId: payment.companyId },
      data: {
        plan: payment.plan,
        status: "active",
        currentPeriodStart: toDate(periodStart),
        currentPeriodEnd: toDate(periodEnd),
        nextPlan: null,
        renewalAttempts: 0,
        nextAttemptAt: null,
      },
    });
    event = "subscriptionRenewed";
  } else {
    // A new subscription, or a renewal paid by hand: a month from today.
    periodStart = today;
    periodEnd = addMonths(today, 1);
    const data = {
      plan: payment.plan,
      status: "active" as const,
      currentPeriodStart: toDate(periodStart),
      currentPeriodEnd: toDate(periodEnd),
      cancelAtPeriodEnd: false,
      nextPlan: null,
      renewalAttempts: 0,
      nextAttemptAt: null,
      ...card,
    };
    await tx.subscription.upsert({
      where: { companyId: payment.companyId },
      create: { companyId: payment.companyId, ...data },
      update: data,
    });
    event = payment.kind === "renewal" ? "subscriptionRenewed" : "subscriptionStarted";
  }

  await tx.billingPayment.update({
    where: { id: payment.id },
    data: { periodStart: toDate(periodStart), periodEnd: toDate(periodEnd) },
  });
  await audit(
    tx,
    payment.companyId,
    {
      action: "settings",
      event,
      item: { type: "subscription", ref: paymentNumber(payment.number) },
      values: {
        plan: payment.plan,
        amount: moneyString(payment.amount),
        through: periodEnd,
      },
    },
    SYSTEM,
  );
}

async function applyFailedRenewal(tx: Db, payment: BillingPayment, reason?: string) {
  const sub = await tx.subscription.findUnique({
    where: { companyId: payment.companyId },
  });
  if (!sub || sub.status === "ended") return;
  const attempts = sub.renewalAttempts + 1;
  await tx.subscription.update({
    where: { companyId: payment.companyId },
    data: {
      status: "pastDue",
      renewalAttempts: attempts,
      nextAttemptAt: new Date(Date.now() + DAY_MS),
    },
  });
  await audit(
    tx,
    payment.companyId,
    {
      action: "settings",
      event: "renewalFailed",
      item: { type: "subscription", ref: paymentNumber(payment.number) },
      values: {
        plan: payment.plan,
        amount: moneyString(payment.amount),
        count: attempts,
        detail: reason,
      },
    },
    SYSTEM,
  );
}

/** The card Paymob saved during a checkout (its TOKEN callback). */
export async function saveCard(orderId: string, card: { token: string; masked: string; brand: string }) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billingPayment.findUnique({
      where: { gatewayOrderId: orderId },
    });
    if (!payment) return false;
    await lockSubscription(tx, payment.companyId);
    const data = {
      cardToken: card.token,
      cardMasked: card.masked.slice(0, 40),
      cardBrand: card.brand.slice(0, 40),
    };
    await tx.billingPayment.update({ where: { id: payment.id }, data });
    // Already paid (the token came second): the subscription renews on this card from now on.
    const current = await tx.billingPayment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { status: true },
    });
    if (current.status === "paid") {
      await tx.subscription.updateMany({
        where: { companyId: payment.companyId, status: { not: "ended" } },
        data,
      });
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Changing or stopping (owner)
// ---------------------------------------------------------------------------

async function openSubscription(tx: Db, companyId: string) {
  await lockSubscription(tx, companyId);
  const sub = await tx.subscription.findUnique({ where: { companyId } });
  if (!sub || sub.status === "ended") throw new AppError(409, "NO_SUBSCRIPTION", "The company is on the free plan");
  return sub;
}

/** A lower paid plan from the next period. */
export async function scheduleDowngrade(actor: Actor, plan: PlanId) {
  await prisma.$transaction(async (tx) => {
    const sub = await openSubscription(tx, actor.companyId);
    if (plan === "free" || !isHigher(sub.plan, plan)) {
      throw new AppError(409, "NOT_A_DOWNGRADE", "Choose a lower paid plan (or cancel to go back to free)");
    }
    await tx.subscription.update({
      where: { companyId: actor.companyId },
      data: { nextPlan: plan, cancelAtPeriodEnd: false },
    });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "planChangeScheduled",
      item: { type: "subscription" },
      values: { plan, through: toIso(sub.currentPeriodEnd) },
    });
  });
  return getBilling(actor.companyId);
}

/** Back to free at the end of the period (at once if the renewal wasn't paid). */
export async function cancelSubscription(actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const sub = await openSubscription(tx, actor.companyId);
    if (sub.status === "pastDue") {
      await endSubscription(tx, sub, "canceled");
      return;
    }
    await tx.subscription.update({
      where: { companyId: actor.companyId },
      data: { cancelAtPeriodEnd: true, nextPlan: null },
    });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "subscriptionCanceled",
      item: { type: "subscription" },
      values: { plan: sub.plan, through: toIso(sub.currentPeriodEnd) },
    });
  });
  return getBilling(actor.companyId);
}

/** Undoes a cancellation or a scheduled lower plan. */
export async function resumeSubscription(actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const sub = await openSubscription(tx, actor.companyId);
    if (!sub.cancelAtPeriodEnd && !sub.nextPlan) return;
    await tx.subscription.update({
      where: { companyId: actor.companyId },
      data: { cancelAtPeriodEnd: false, nextPlan: null },
    });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "subscriptionResumed",
      item: { type: "subscription" },
      values: { plan: sub.plan },
    });
  });
  return getBilling(actor.companyId);
}

/** Back to the free plan: recurring invoices (a paid feature) are paused. */
async function endSubscription(tx: Db, sub: Subscription, reason: "canceled" | "unpaid") {
  await tx.subscription.update({
    where: { companyId: sub.companyId },
    data: {
      status: "ended",
      cancelAtPeriodEnd: false,
      nextPlan: null,
      nextAttemptAt: null,
    },
  });
  const paused = await tx.recurringInvoice.updateMany({
    where: { companyId: sub.companyId, status: "active" },
    data: { status: "paused" },
  });
  await audit(
    tx,
    sub.companyId,
    {
      action: "settings",
      event: "subscriptionEnded",
      item: { type: "subscription" },
      values: { plan: sub.plan, why: reason, count: paused.count },
    },
    SYSTEM,
  );
}

// ---------------------------------------------------------------------------
// The renewal job
// ---------------------------------------------------------------------------

type Charge = {
  paymentId: string;
  amount: Decimal;
  plan: PlanId;
  cardToken: string;
  ownerId: string | null;
};

/** Decides what a subscription needs today; returns a charge to make (made outside the transaction). */
async function nextStep(companyId: string, now: Date): Promise<Charge | null> {
  const today = businessToday(now);
  return prisma.$transaction(async (tx) => {
    await lockSubscription(tx, companyId);
    const sub = await tx.subscription.findUnique({ where: { companyId } });
    if (!sub || sub.status === "ended") return null;
    const end = toIso(sub.currentPeriodEnd);
    if (sub.status === "active" && end > today) return null;

    // An automatic charge is still waiting for Paymob's answer.
    const waiting = await tx.billingPayment.count({
      where: { companyId, status: "pending", automatic: true },
    });
    if (waiting > 0) return null;

    if (sub.status === "active") {
      if (sub.cancelAtPeriodEnd) {
        await endSubscription(tx, sub, "canceled");
        return null;
      }
      if (!sub.cardToken) {
        // No saved card: the owner pays by hand during the grace days.
        await tx.subscription.update({
          where: { companyId },
          data: { status: "pastDue", nextAttemptAt: null },
        });
        await audit(
          tx,
          companyId,
          {
            action: "settings",
            event: "renewalDue",
            item: { type: "subscription" },
            values: {
              plan: sub.nextPlan ?? sub.plan,
              through: addDays(end, GRACE_DAYS),
            },
          },
          SYSTEM,
        );
        return null;
      }
    } else {
      // pastDue: give up after the grace days, else try the card again (a day apart, a few times).
      if (today >= addDays(end, GRACE_DAYS)) {
        await endSubscription(tx, sub, "unpaid");
        return null;
      }
      if (!sub.cardToken || sub.renewalAttempts >= MAX_RENEWAL_ATTEMPTS) return null;
      if (sub.nextAttemptAt && sub.nextAttemptAt > now) return null;
    }

    const plan = sub.nextPlan ?? sub.plan;
    const payment = await tx.billingPayment.create({
      data: {
        companyId,
        kind: "renewal",
        plan,
        amount: price(plan),
        automatic: true,
        renewalKey: `${companyId}:${end}:${sub.renewalAttempts + 1}`,
      },
    });
    const owner = await tx.user.findFirst({
      where: { companyId, role: "owner" },
      select: { id: true },
    });
    return {
      paymentId: payment.id,
      amount: payment.amount,
      plan,
      cardToken: sub.cardToken,
      ownerId: owner?.id ?? null,
    };
  });
}

async function charge(step: Charge) {
  let result: ChargeResult;
  try {
    const payer: Payer = step.ownerId
      ? await payerFor(step.ownerId)
      : {
          firstName: "NA",
          lastName: "NA",
          email: "billing@mizan.invalid",
          phone: "NA",
        };
    result = await gateway().chargeCard(
      {
        reference: step.paymentId,
        amountCents: cents(step.amount),
        description: `Mizan ${step.plan} plan`,
        payer,
        cardToken: step.cardToken,
      },
      async (orderId) => {
        await prisma.billingPayment.update({
          where: { id: step.paymentId },
          data: { gatewayOrderId: orderId },
        });
      },
    );
  } catch (err) {
    logger.error({ err, paymentId: step.paymentId }, "Renewal charge failed");
    result = {
      orderId: "",
      status: "failed",
      reason: "The payment service didn't answer",
    };
  }
  // Pending: Paymob's callback settles it.
  if (result.status === "pending") return "pending";
  return settlePayment(step.paymentId, {
    paid: result.status === "paid",
    transactionId: result.transactionId,
    reason: result.reason,
  });
}

/** Renews what is due, retries what failed, ends what ran out (hourly). */
export async function runBilling(now = new Date()) {
  const today = businessToday(now);
  // Checkouts nobody finished.
  const expired = await prisma.billingPayment.updateMany({
    where: {
      status: "pending",
      automatic: false,
      createdAt: { lt: new Date(now.getTime() - CHECKOUT_TTL_MS) },
    },
    data: { status: "failed", failureReason: "Not completed" },
  });
  const subs = await prisma.subscription.findMany({
    where: {
      OR: [{ status: "active", currentPeriodEnd: { lte: toDate(today) } }, { status: "pastDue" }],
    },
    select: { companyId: true },
  });
  const result = {
    checked: subs.length,
    expired: expired.count,
    paid: 0,
    failed: 0,
    pending: 0,
  };
  for (const { companyId } of subs) {
    try {
      const step = await nextStep(companyId, now);
      if (!step) continue;
      const outcome = await charge(step);
      if (outcome === "paid") result.paid += 1;
      else if (outcome === "pending") result.pending += 1;
      else result.failed += 1;
    } catch (err) {
      logger.error({ err, companyId }, "Subscription renewal failed");
    }
  }
  return result;
}
