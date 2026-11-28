// Automatic emails, each behind a switch in Settings → Notifications:
// - customerReminders: payment reminders to customers before and after the due date;
// - overdueInvoice:    the team's morning list of overdue invoices;
// - taskReminder:      each person's tasks due today, in the morning;
// - weeklyDigest:      Saturday's summary of the past week;
// - newPayment:        a payment someone else recorded, or a customer paid online (right away).
// Every email is claimed in sent_notices first (a unique key per company), so a second run,
// a restart or another server never sends it twice; a failed send gives the claim back.
import type { InvoiceStatus, Role } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { addDays, BUSINESS_TIME_ZONE, businessToday, daysBetween, toDate, toIso } from "../../lib/dates.js";
import { logger } from "../../lib/logger.js";
import { sendMail } from "../../lib/mailer.js";
import { moneyString, ZERO } from "../../lib/money.js";
import type { Permission } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { overdueAlertEmail, paymentNoticeEmail, tasksDueEmail, weeklyDigestEmail, type Locale } from "../email/templates.js";
import { sendAutoReminder } from "../invoices/invoices.service.js";
import { notificationsOf } from "../settings/settings.service.js";

/** Users have no language of their own yet: the emails are in Arabic, like most of the app's use. */
const LOCALE: Locale = "ar";
/** Morning emails go from this hour (Cairo) on; earlier runs wait. */
const FROM_HOUR = 9;
/** A reminder this many days before the due date... */
const BEFORE_DUE_DAYS = 3;
/** ...then, once late, one in each of these weeks (days late 1-7, 8-14, 15-21). */
const OVERDUE_STEPS = [1, 8, 15];
const OVERDUE_LAST_DAY = 21;
/** No automatic reminder within this many days of the invoice being emailed or reminded. */
const QUIET_DAYS = 3;
/** At most this many customer reminders per company per run (the rest go next hour). */
const REMINDERS_PER_RUN = 50;
const OPEN: InvoiceStatus[] = ["sent", "partial"];
const MONEY_ROLES: Role[] = ["owner", "accountant"];

const appUrl = (path: string) => new URL(`/${LOCALE}/${path}`, config.APP_URL).toString();

/** The hour of the day in Cairo (0-23). */
export function businessHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: BUSINESS_TIME_ZONE }).format(now));
}

const isSaturday = (iso: string) => toDate(iso).getUTCDay() === 6;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

async function claim(companyId: string, key: string) {
  const { count } = await prisma.sentNotice.createMany({ data: [{ companyId, key }], skipDuplicates: true });
  return count === 1;
}

const sentAlready = async (companyId: string, key: string) =>
  (await prisma.sentNotice.count({ where: { companyId, key } })) > 0;

/** Claims `key`, runs `send`; gives the claim back when it fails or had nothing to send. */
async function once(companyId: string, key: string, send: () => Promise<boolean>) {
  if (!(await claim(companyId, key))) return 0;
  try {
    if (await send()) return 1;
  } catch (err) {
    logger.error({ err, companyId, key }, "Notice failed");
  }
  await prisma.sentNotice.deleteMany({ where: { companyId, key } });
  return 0;
}

/**
 * Team members who handle the money, with a confirmed address (nothing goes to an unconfirmed
 * one): the owner and accountants, and anyone whose own role may record payments.
 */
function moneyPeople(companyId: string) {
  return prisma.user.findMany({
    where: {
      companyId,
      emailVerifiedAt: { not: null },
      OR: [
        { role: { in: MONEY_ROLES } },
        { role: "custom", customRole: { permissions: { has: "recordPayments" satisfies Permission } } },
      ],
    },
    select: { id: true, email: true, fullName: true },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// The hourly run
// ---------------------------------------------------------------------------

type CompanyRow = { id: string; name: string; currency: string; notifications: unknown };

/** Everything due now, for every company. Returns how many emails went. */
export async function runNotices(now = new Date()) {
  if (businessHour(now) < FROM_HOUR) return { sent: 0 };
  const today = businessToday(now);
  const companies = await prisma.company.findMany({ select: { id: true, name: true, currency: true, notifications: true } });
  let sent = 0;
  for (const company of companies) {
    const on = notificationsOf(company.notifications);
    try {
      if (on.customerReminders) sent += await customerReminders(company, today);
      if (on.overdueInvoice) sent += await overdueAlerts(company, today);
      if (on.taskReminder) sent += await taskReminders(company, today);
      if (on.weeklyDigest && isSaturday(today)) sent += await weeklyDigests(company, today);
    } catch (err) {
      logger.error({ err, companyId: company.id }, "Notices failed for a company");
    }
  }
  return { sent };
}

// ---------------------------------------------------------------------------
// Customers: payment reminders
// ---------------------------------------------------------------------------

/** Which reminder an invoice is due for today: "before", "overdue:1..3", or none. */
export function reminderStage(dueDate: string, today: string) {
  const late = daysBetween(dueDate, today);
  if (late === -BEFORE_DUE_DAYS) return "before";
  if (late < OVERDUE_STEPS[0]! || late > OVERDUE_LAST_DAY) return null;
  const step = OVERDUE_STEPS.filter((from) => late >= from).length;
  return `overdue:${step}`;
}

async function customerReminders(company: CompanyRow, today: string) {
  // Sent in the owner's name (replies go to them), and only from a confirmed address.
  const owner = await prisma.user.findFirst({
    where: { companyId: company.id, role: "owner", emailVerifiedAt: { not: null } },
    select: { email: true },
    orderBy: { createdAt: "asc" },
  });
  if (!owner) return 0;
  const quietSince = new Date(toDate(today).getTime() - QUIET_DAYS * 86_400_000);
  const invoices = await prisma.invoice.findMany({
    where: {
      companyId: company.id,
      status: { in: OPEN },
      publicToken: { not: null },
      OR: [
        { dueDate: toDate(addDays(today, BEFORE_DUE_DAYS)) },
        { dueDate: { lte: toDate(addDays(today, -OVERDUE_STEPS[0]!)), gte: toDate(addDays(today, -OVERDUE_LAST_DAY)) } },
      ],
      AND: [{ OR: [{ customer: { email: { not: null } } }, { customerEmail: { not: null } }] }],
    },
    select: {
      id: true,
      dueDate: true,
      // Emailed or reminded lately (by hand or automatically): this one waits.
      events: { where: { type: { in: ["emailed", "reminderSent"] }, createdAt: { gte: quietSince } }, select: { id: true }, take: 1 },
    },
    orderBy: { dueDate: "asc" },
  });
  const from = { company: company.name, replyTo: owner.email };
  let sent = 0;
  for (const invoice of invoices) {
    if (sent >= REMINDERS_PER_RUN) break;
    const stage = reminderStage(toIso(invoice.dueDate), today);
    if (!stage || invoice.events.length > 0) continue;
    sent += await once(company.id, `reminder:${invoice.id}:${stage}`, () =>
      sendAutoReminder(company.id, invoice.id, from, LOCALE),
    );
  }
  return sent;
}

// ---------------------------------------------------------------------------
// The team: overdue invoices, tasks, the weekly digest
// ---------------------------------------------------------------------------

const OVERDUE_LISTED = 10;

async function overdueAlerts(company: CompanyRow, today: string) {
  const people = await moneyPeople(company.id);
  const waiting = [];
  for (const person of people) {
    if (!(await sentAlready(company.id, `overdue:${today}:${person.id}`))) waiting.push(person);
  }
  if (waiting.length === 0) return 0;
  const overdue = await prisma.invoice.findMany({
    where: { companyId: company.id, status: { in: OPEN }, dueDate: { lt: toDate(today) } },
    select: { number: true, numberPrefix: true, customerName: true, total: true, amountPaid: true, credited: true, dueDate: true },
    orderBy: { dueDate: "asc" },
  });
  if (overdue.length === 0) return 0;
  const total = overdue.reduce((sum, i) => sum.plus(i.total.minus(i.amountPaid).minus(i.credited)), ZERO);
  const facts = {
    count: overdue.length,
    total: moneyString(total),
    currency: company.currency,
    items: overdue.slice(0, OVERDUE_LISTED).map((i) => ({
      number: `${i.numberPrefix}${i.number}`,
      customer: i.customerName,
      remaining: moneyString(i.total.minus(i.amountPaid).minus(i.credited)),
      daysLate: daysBetween(toIso(i.dueDate), today),
    })),
    url: appUrl("invoices"),
  };
  let sent = 0;
  for (const person of waiting) {
    sent += await once(company.id, `overdue:${today}:${person.id}`, async () => {
      await sendMail(overdueAlertEmail(LOCALE, { email: person.email, name: person.fullName }, company.name, facts));
      return true;
    });
  }
  return sent;
}

async function taskReminders(company: CompanyRow, today: string) {
  const tasks = await prisma.task.findMany({
    where: { companyId: company.id, dueDate: toDate(today), completedOn: null },
    select: {
      title: true,
      priority: true,
      customer: { select: { name: true } },
      createdBy: { select: { id: true, email: true, fullName: true, emailVerifiedAt: true, companyId: true } },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (tasks.length === 0) return 0;
  // Each person gets the tasks they made; a task whose maker left goes to the owner.
  const owner = await prisma.user.findFirst({
    where: { companyId: company.id, role: "owner", emailVerifiedAt: { not: null } },
    select: { id: true, email: true, fullName: true },
    orderBy: { createdAt: "asc" },
  });
  const byPerson = new Map<string, { person: { id: string; email: string; fullName: string }; tasks: typeof tasks }>();
  for (const task of tasks) {
    const maker = task.createdBy;
    const person = maker && maker.companyId === company.id && maker.emailVerifiedAt ? maker : owner;
    if (!person) continue;
    const entry = byPerson.get(person.id) ?? { person, tasks: [] };
    entry.tasks.push(task);
    byPerson.set(person.id, entry);
  }
  let sent = 0;
  for (const { person, tasks: theirs } of byPerson.values()) {
    sent += await once(company.id, `tasks:${today}:${person.id}`, async () => {
      await sendMail(
        tasksDueEmail(
          LOCALE,
          { email: person.email, name: person.fullName },
          theirs.map((t) => ({ title: t.title, priority: t.priority, customer: t.customer?.name ?? null })),
          appUrl("tasks"),
        ),
      );
      return true;
    });
  }
  return sent;
}

async function weeklyDigests(company: CompanyRow, today: string) {
  const people = await moneyPeople(company.id);
  const waiting = [];
  for (const person of people) {
    if (!(await sentAlready(company.id, `digest:${today}:${person.id}`))) waiting.push(person);
  }
  if (waiting.length === 0) return 0;
  // The past seven days (Saturday to Friday), and where things stand today.
  const from = addDays(today, -7);
  const to = addDays(today, -1);
  const week = { gte: toDate(from), lte: toDate(to) };
  const [invoiced, collected, expenses, open] = await Promise.all([
    prisma.invoice.aggregate({
      where: { companyId: company.id, status: { notIn: ["draft", "cancelled"] }, issueDate: week },
      _sum: { total: true },
      _count: true,
    }),
    prisma.invoicePayment.aggregate({ where: { companyId: company.id, status: "cleared", date: week }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { companyId: company.id, date: week }, _sum: { amount: true } }),
    prisma.invoice.findMany({
      where: { companyId: company.id, status: { in: OPEN } },
      select: { total: true, amountPaid: true, credited: true, dueDate: true },
    }),
  ]);
  const soonEnd = addDays(today, 6);
  let outstanding = ZERO;
  let overdue = ZERO;
  let overdueCount = 0;
  let dueSoon = ZERO;
  for (const i of open) {
    const left = i.total.minus(i.amountPaid).minus(i.credited);
    const due = toIso(i.dueDate);
    outstanding = outstanding.plus(left);
    if (due < today) {
      overdue = overdue.plus(left);
      overdueCount++;
    } else if (due <= soonEnd) dueSoon = dueSoon.plus(left);
  }
  const facts = {
    from,
    to,
    currency: company.currency,
    invoiced: moneyString(invoiced._sum.total ?? ZERO),
    invoicedCount: invoiced._count,
    collected: moneyString(collected._sum.amount ?? ZERO),
    expenses: moneyString(expenses._sum.amount ?? ZERO),
    outstanding: moneyString(outstanding),
    overdue: moneyString(overdue),
    overdueCount,
    dueSoon: moneyString(dueSoon),
    url: appUrl("dashboard"),
  };
  let sent = 0;
  for (const person of waiting) {
    sent += await once(company.id, `digest:${today}:${person.id}`, async () => {
      await sendMail(weeklyDigestEmail(LOCALE, { email: person.email, name: person.fullName }, company.name, facts));
      return true;
    });
  }
  return sent;
}

// ---------------------------------------------------------------------------
// A new payment (right away, not on the hourly run)
// ---------------------------------------------------------------------------

/**
 * Tells the money people about a payment, except whoever recorded it (an online payment
 * has no recorder: everyone hears). Call it after the payment's transaction commits; it
 * never throws, so a failed email can't undo or fail the payment.
 */
export async function notifyPayment(companyId: string, paymentId: string, recordedBy: string | null) {
  try {
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { currency: true, notifications: true } });
    if (!company || !notificationsOf(company.notifications).newPayment) return;
    const people = (await moneyPeople(companyId)).filter((p) => p.id !== recordedBy);
    if (people.length === 0) return;
    const payment = await prisma.invoicePayment.findFirst({
      where: { id: paymentId, companyId },
      select: {
        amount: true,
        date: true,
        method: true,
        invoice: { select: { number: true, numberPrefix: true, customerName: true } },
        createdBy: { select: { fullName: true } },
      },
    });
    if (!payment) return;
    for (const person of people) {
      await sendMail(
        paymentNoticeEmail(LOCALE, { email: person.email, name: person.fullName }, {
          invoice: `${payment.invoice.numberPrefix}${payment.invoice.number}`,
          customer: payment.invoice.customerName,
          amount: moneyString(payment.amount),
          currency: company.currency,
          method: payment.method,
          date: toIso(payment.date),
          by: recordedBy ? (payment.createdBy?.fullName ?? null) : null,
          url: appUrl(`invoices/${payment.invoice.number}`),
        }),
      );
    }
  } catch (err) {
    logger.error({ err, companyId, paymentId }, "Payment notice failed");
  }
}
