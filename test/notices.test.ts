import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, toDate } from "../src/lib/dates.js";
import { testMail } from "../src/lib/mailer.js";
import { reminderStage, runNotices } from "../src/modules/notifications/notices.service.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  testMail.outbox.length = 0;
  testMail.fail = false;
});
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
/** 10:00 in Cairo (in winter and summer alike) on `iso`, and 07:00. */
const morning = (iso = today()) => new Date(`${iso}T08:00:00Z`);
const early = (iso = today()) => new Date(`${iso}T04:30:00Z`);
const tagged = (tag: string) => testMail.outbox.filter((m) => m.tag === tag);

const notifications = (on: Partial<Record<string, boolean>>) => ({
  notifications: { customerReminders: false, overdueInvoice: false, newPayment: false, taskReminder: false, weeklyDigest: false, ...on },
});
const setNotifications = (token: string, on: Partial<Record<string, boolean>>) =>
  api().patch("/api/settings").set(auth(token)).send(notifications(on)).expect(200);

/** An owner with a confirmed email (nothing goes to an unconfirmed one), and a customer with an email. */
async function company() {
  const owner = await ownerSession();
  await prisma.user.updateMany({ where: { companyId: owner.companyId }, data: { emailVerifiedAt: new Date() } });
  const customer = (await api().post("/api/customers").set(auth(owner.token)).send({ name: "شركة النيل", email: "nile@example.com" })).body
    .customer as { id: string };
  return { owner, customer };
}

/** An issued invoice for 1000, due on `due`. */
async function invoiceDue(token: string, customerId: string, due: string, companyId: string) {
  const res = await api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate: addDays(today(), -40), terms: 0, send: true, items: [{ description: "تصميم", quantity: "1", unitPrice: "1000" }] });
  expect(res.status).toBe(201);
  await prisma.invoice.update({ where: { id: res.body.invoice.id }, data: { dueDate: toDate(due) } });
  const row = await prisma.invoice.findFirstOrThrow({ where: { id: res.body.invoice.id, companyId }, select: { id: true, number: true } });
  return row;
}

describe("which reminder an invoice is due for", () => {
  it("3 days before, then once in each of the first three weeks late", () => {
    const t = "2026-11-28";
    expect(reminderStage("2026-12-01", t)).toBe("before");
    expect(reminderStage("2026-12-02", t)).toBeNull();
    expect(reminderStage("2026-11-28", t)).toBeNull();
    expect(reminderStage("2026-11-27", t)).toBe("overdue:1");
    expect(reminderStage("2026-11-21", t)).toBe("overdue:1");
    expect(reminderStage("2026-11-20", t)).toBe("overdue:2");
    expect(reminderStage("2026-11-13", t)).toBe("overdue:3");
    expect(reminderStage("2026-11-07", t)).toBe("overdue:3");
    expect(reminderStage("2026-11-06", t)).toBeNull();
  });
});

describe("automatic payment reminders to customers", () => {
  it("off until turned on; then due ones go once, from the owner, and are in the history", async () => {
    const { owner, customer } = await company();
    const soon = await invoiceDue(owner.token, customer.id, addDays(today(), 3), owner.companyId);
    const late = await invoiceDue(owner.token, customer.id, addDays(today(), -8), owner.companyId);
    // Reminded by hand yesterday: it waits a few days.
    const reminded = await invoiceDue(owner.token, customer.id, addDays(today(), -2), owner.companyId);
    await api().post(`/api/invoices/${reminded.number}/reminders`).set(auth(owner.token)).send({ channel: "whatsapp", message: "فاكرين الفاتورة؟", locale: "ar" }).expect(201);

    await runNotices(morning());
    expect(tagged("reminder")).toHaveLength(0);

    await setNotifications(owner.token, { customerReminders: true });
    expect((await runNotices(early())).sent).toBe(0);
    await runNotices(morning());
    const sent = tagged("reminder");
    expect(sent.map((m) => m.to)).toEqual(["nile@example.com", "nile@example.com"]);
    expect(sent.every((m) => m.replyTo === owner.email)).toBe(true);
    expect(sent.some((m) => m.subject.includes("متأخرة"))).toBe(true);

    // Not twice.
    await runNotices(morning());
    expect(tagged("reminder")).toHaveLength(2);

    const history = await prisma.invoiceEvent.findMany({ where: { invoiceId: { in: [soon.id, late.id] }, type: "reminderSent" } });
    expect(history).toHaveLength(2);
    expect(history.every((e) => (e.values as { auto?: boolean }).auto === true && e.userId === null)).toBe(true);
    expect(await prisma.invoiceEvent.count({ where: { invoiceId: reminded.id, type: "reminderSent" } })).toBe(1);
  });

  it("a paid invoice or a customer without an email gets none; an unconfirmed owner sends none", async () => {
    const { owner, customer } = await company();
    await setNotifications(owner.token, { customerReminders: true });
    const paid = await invoiceDue(owner.token, customer.id, addDays(today(), -8), owner.companyId);
    await api()
      .post(`/api/invoices/${paid.number}/payments`)
      .set(auth(owner.token))
      .send({ amount: "1140", date: today(), method: "cash", account: "cashbox" })
      .expect(201);
    const noEmail = (await api().post("/api/customers").set(auth(owner.token)).send({ name: "بدون إيميل" })).body.customer;
    await invoiceDue(owner.token, noEmail.id, addDays(today(), -8), owner.companyId);
    await runNotices(morning());
    expect(tagged("reminder")).toHaveLength(0);

    await invoiceDue(owner.token, customer.id, addDays(today(), -8), owner.companyId);
    await prisma.user.updateMany({ where: { companyId: owner.companyId }, data: { emailVerifiedAt: null } });
    await runNotices(morning());
    expect(tagged("reminder")).toHaveLength(0);
  });
});

describe("notices to the team", () => {
  it("overdue invoices: each money person with a confirmed email, once a day", async () => {
    const { owner, customer } = await company();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    // Custom roles: one that records payments hears about the money, one for tasks doesn't.
    const customMember = async (permissions: string[]) => {
      const role = (await api().post("/api/roles").set(auth(owner.token)).send({ name: permissions.join("+"), permissions }).expect(201)).body.role;
      const member = await teamMember(owner.token, "viewer");
      await api().patch(`/api/users/${member.userId}`).set(auth(owner.token)).send({ role: "custom", customRoleId: role.id }).expect(200);
      return member;
    };
    const cashier = await customMember(["viewCustomers", "recordPayments"]);
    const planner = await customMember(["viewCustomers", "tasks"]);
    await prisma.user.updateMany({ where: { companyId: owner.companyId }, data: { emailVerifiedAt: new Date() } });
    await setNotifications(owner.token, { overdueInvoice: true });

    await runNotices(morning());
    expect(tagged("notice-overdue")).toHaveLength(0); // nothing overdue

    await invoiceDue(owner.token, customer.id, addDays(today(), -5), owner.companyId);
    await runNotices(morning());
    const sent = tagged("notice-overdue");
    expect(sent.map((m) => m.to).sort()).toEqual([accountant.email, cashier.email, owner.email].sort());
    expect(sent.map((m) => m.to)).not.toContain(sales.email);
    expect(sent.map((m) => m.to)).not.toContain(planner.email);
    expect(sent[0]!.text).toContain("متأخرة 5 يوم");

    await runNotices(morning());
    expect(tagged("notice-overdue")).toHaveLength(3);
    // The next day, again.
    await runNotices(morning(addDays(today(), 1)));
    expect(tagged("notice-overdue")).toHaveLength(6);
  });

  it("tasks due today go to whoever made them, in the morning", async () => {
    const { owner } = await company();
    await setNotifications(owner.token, { taskReminder: true });
    await api().post("/api/tasks").set(auth(owner.token)).send({ title: "اتصل بشركة النيل", due: today(), priority: "urgent" }).expect(201);
    await api().post("/api/tasks").set(auth(owner.token)).send({ title: "مهمة بكره", due: addDays(today(), 1) }).expect(201);

    await runNotices(early());
    expect(tagged("notice-tasks")).toHaveLength(0);
    await runNotices(morning());
    const [mail] = tagged("notice-tasks");
    expect(mail?.to).toBe(owner.email);
    expect(mail?.text).toContain("اتصل بشركة النيل");
    expect(mail?.text).not.toContain("مهمة بكره");
  });

  it("the weekly digest goes on Saturdays only", async () => {
    const { owner } = await company();
    await setNotifications(owner.token, { weeklyDigest: true });
    const offset = (6 - toDate(today()).getUTCDay() + 7) % 7;
    const saturday = addDays(today(), offset);
    await runNotices(morning(addDays(saturday, 1)));
    expect(tagged("notice-digest")).toHaveLength(0);
    await runNotices(morning(saturday));
    expect(tagged("notice-digest").map((m) => m.to)).toEqual([owner.email]);
    await runNotices(morning(saturday));
    expect(tagged("notice-digest")).toHaveLength(1);
  });

  it("a new payment: the others hear right away, not whoever recorded it; off, nobody does", async () => {
    const { owner, customer } = await company();
    const accountant = await teamMember(owner.token, "accountant");
    await prisma.user.updateMany({ where: { companyId: owner.companyId }, data: { emailVerifiedAt: new Date() } });
    await setNotifications(owner.token, { newPayment: true });
    const invoice = await invoiceDue(owner.token, customer.id, addDays(today(), 10), owner.companyId);
    const pay = (token: string) =>
      api()
        .post(`/api/invoices/${invoice.number}/payments`)
        .set(auth(token))
        .send({ amount: "100", date: today(), method: "instapay", account: "bank" })
        .expect(201);

    await pay(accountant.token);
    expect(tagged("notice-payment").map((m) => m.to)).toEqual([owner.email]);
    expect(tagged("notice-payment")[0]!.text).toContain("إنستاباي");

    await pay(owner.token);
    expect(tagged("notice-payment").map((m) => m.to)).toEqual([owner.email, accountant.email]);

    await setNotifications(owner.token, { newPayment: false });
    await pay(accountant.token);
    expect(tagged("notice-payment")).toHaveLength(2);
  });
});
