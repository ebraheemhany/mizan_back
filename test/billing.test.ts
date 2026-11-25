import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, addMonths, businessToday, toDate } from "../src/lib/dates.js";
import { runBilling } from "../src/modules/billing/billing.service.js";
import { callbackHmac, DECLINED_TEST_CARD } from "../src/modules/billing/paymob.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember, uniqueEmail } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => businessToday();
const SECRET = "test-hmac-secret";

const billingOf = async (token: string) => (await api().get("/api/billing").set(auth(token))).body.billing;
const paymentsOf = async (token: string) => (await api().get("/api/billing/payments").set(auth(token))).body.items;

async function customerOf(token: string) {
  return (await api().post("/api/customers").set(auth(token)).send({ name: "عميل" })).body.customer as { id: string };
}

const invoice = (token: string, customerId: string) =>
  api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate: today(), terms: 30, send: false, items: [{ description: "خدمة", quantity: "1", unitPrice: "100" }] });

const recurring = (token: string, customerId: string) =>
  api()
    .post("/api/recurring")
    .set(auth(token))
    .send({
      name: "صيانة شهرية",
      customerId,
      frequency: "monthly",
      startDate: addDays(today(), 1),
      endMode: "never",
      terms: 30,
      autoSend: false,
      items: [{ description: "صيانة", quantity: "1", unitPrice: "500" }],
    });

/** Opens a checkout and finishes it on the test page. */
async function pay(token: string, plan: "pro" | "business", outcome: "paid" | "declined" = "paid", save = true) {
  const checkout = await api().post("/api/billing/checkout").set(auth(token)).send({ plan });
  if (checkout.status !== 201) throw new Error(JSON.stringify(checkout.body));
  const id = checkout.body.paymentId as string;
  await api()
    .post(`/api/billing/test-checkout/${id}`)
    .type("form")
    .send(save ? { outcome, save: "1" } : { outcome })
    .expect(303);
  return checkout.body as { paymentId: string; url: string; amount: string; kind: string };
}

/** Sets a company's subscription directly (dates are Cairo yyyy-mm-dd). */
function setSubscription(
  companyId: string,
  data: { plan?: "pro" | "business"; status?: "active" | "pastDue" | "ended"; start?: string; end?: string; cardToken?: string | null; cancelAtPeriodEnd?: boolean },
) {
  const start = data.start ?? addDays(today(), -30);
  const end = data.end ?? today();
  const values = {
    plan: data.plan ?? "pro",
    status: data.status ?? "active",
    currentPeriodStart: toDate(start),
    currentPeriodEnd: toDate(end),
    cardToken: data.cardToken === undefined ? "test-card-ok" : data.cardToken,
    cardMasked: data.cardToken === null ? null : "xxxx-xxxx-xxxx-4242",
    cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
  };
  return prisma.subscription.upsert({ where: { companyId }, create: { companyId, ...values }, update: values });
}

describe("the free plan's limits", () => {
  it("10 invoices a month, one user, no recurring invoices; the plan shows what's used", async () => {
    const owner = await ownerSession({ plan: "free" });
    const customer = await customerOf(owner.token);
    for (let i = 0; i < 10; i++) expect((await invoice(owner.token, customer.id)).status).toBe(201);

    const eleventh = await invoice(owner.token, customer.id);
    expect(eleventh.status).toBe(402);
    expect(eleventh.body.error).toMatchObject({ code: "PLAN_LIMIT_INVOICES", details: { plan: "free", limit: 10 } });

    const invite = await api().post("/api/invitations").set(auth(owner.token)).send({ name: "سارة", email: uniqueEmail(), role: "sales" });
    expect(invite.status).toBe(402);
    expect(invite.body.error.code).toBe("PLAN_LIMIT_USERS");

    const template = await recurring(owner.token, customer.id);
    expect(template.status).toBe(402);
    expect(template.body.error.code).toBe("PLAN_FEATURE");

    expect(await billingOf(owner.token)).toMatchObject({
      plan: "free",
      subscription: null,
      usage: { users: 1, usersLimit: 1, invoicesThisMonth: 10, invoicesLimit: 10 },
      testMode: true,
    });
    // The dashboard's plan card counts the same.
    expect((await api().get("/api/dashboard").set(auth(owner.token))).body.invoicesThisMonth).toBe(10);
  });
});

describe("subscribing", () => {
  it("checkout → pay on the test page → the plan starts, the card is saved, it's in the history and the log", async () => {
    const owner = await ownerSession({ plan: "free" });
    const checkout = await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "pro", locale: "en" });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toMatchObject({ amount: "299.00", kind: "subscribe" });
    expect(checkout.body.url).toBe(`http://localhost:4000/api/billing/test-checkout/${checkout.body.paymentId}`);

    const page = await api().get(`/api/billing/test-checkout/${checkout.body.paymentId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("299.00 EGP");

    const done = await api()
      .post(`/api/billing/test-checkout/${checkout.body.paymentId}`)
      .type("form")
      .send({ outcome: "paid", save: "1" });
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(`http://localhost:3000/en/billing/return?payment=${checkout.body.paymentId}`);

    const billing = await billingOf(owner.token);
    expect(billing).toMatchObject({
      plan: "pro",
      subscription: {
        status: "active",
        periodStart: today(),
        periodEnd: addMonths(today(), 1),
        cancelAtPeriodEnd: false,
        card: { masked: "xxxx-xxxx-xxxx-4242", brand: "Visa" },
      },
      usage: { usersLimit: 10, invoicesLimit: null },
    });
    const [payment] = await paymentsOf(owner.token);
    expect(payment).toMatchObject({ kind: "subscribe", plan: "pro", amount: "299.00", status: "paid", periodEnd: addMonths(today(), 1) });
    expect(payment.number).toMatch(/^SUB-\d{5}$/);
    const read = await api().get(`/api/billing/payments/${checkout.body.paymentId}`).set(auth(owner.token));
    expect(read.body.payment.status).toBe("paid");

    // Paid once: the test page is gone, and inviting works now.
    expect((await api().get(`/api/billing/test-checkout/${checkout.body.paymentId}`)).status).toBe(404);
    expect((await api().post("/api/invitations").set(auth(owner.token)).send({ name: "سارة", email: uniqueEmail(), role: "sales" })).status).toBe(201);

    const log = await api().get("/api/audit?action=settings").set(auth(owner.token));
    expect(log.body.items[0]).toMatchObject({ event: "subscriptionStarted", values: { plan: "pro", amount: "299.00" } });
  });

  it("a declined payment changes nothing; the same plan or a lower one can't be bought", async () => {
    const owner = await ownerSession({ plan: "free" });
    await pay(owner.token, "business", "declined");
    expect((await billingOf(owner.token)).plan).toBe("free");
    expect((await paymentsOf(owner.token))[0]).toMatchObject({ status: "failed" });

    await pay(owner.token, "business");
    const same = await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "business" });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("ALREADY_ON_PLAN");
    const lower = await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "pro" });
    expect(lower.body.error.code).toBe("DOWNGRADE_AT_PERIOD_END");
  });

  it("only the owner pays or changes the plan; everyone can see it", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");
    expect((await api().get("/api/billing").set(auth(accountant.token))).status).toBe(200);
    expect((await api().post("/api/billing/checkout").set(auth(accountant.token)).send({ plan: "business" })).status).toBe(403);
    expect((await api().get("/api/billing/payments").set(auth(accountant.token))).status).toBe(403);
    expect((await api().post("/api/billing/cancel").set(auth(accountant.token))).status).toBe(403);
    expect((await api().get("/api/billing")).status).toBe(401);
  });
});

describe("Paymob's callbacks", () => {
  /** A transaction callback as Paymob sends it, for one of our payments. */
  function transaction(paymentId: string, orderId: string, amountCents: number, success = true) {
    return {
      id: 192036465,
      pending: false,
      amount_cents: amountCents,
      success,
      is_auth: false,
      is_capture: false,
      is_standalone_payment: true,
      is_voided: false,
      is_refunded: false,
      is_3d_secure: true,
      integration_id: 4097558,
      has_parent_transaction: false,
      error_occured: false,
      created_at: "2026-11-21T11:33:44.592345",
      currency: "EGP",
      owner: 302852,
      order: { id: orderId, merchant_order_id: paymentId },
      source_data: { pan: "2346", type: "card", sub_type: "MasterCard" },
      data: { message: success ? "Approved" : "Do not honor" },
    };
  }
  const send = (type: "TRANSACTION" | "TOKEN", obj: object, hmac = callbackHmac(type, obj, SECRET)) =>
    api().post(`/api/public/paymob/webhook?hmac=${hmac}`).send({ type, obj });

  it("a signed payment settles once; the card token is saved; a bad signature is refused", async () => {
    const owner = await ownerSession({ plan: "free" });
    const checkout = (await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "pro" })).body;
    const orderId = `test-${checkout.paymentId}`;
    const obj = transaction(checkout.paymentId, orderId, 29900);

    expect((await send("TRANSACTION", obj, "0".repeat(128))).status).toBe(401);
    expect((await api().post("/api/public/paymob/webhook").send({ type: "TRANSACTION", obj })).status).toBe(401);
    expect((await billingOf(owner.token)).plan).toBe("free");

    expect((await send("TRANSACTION", obj)).status).toBe(200);
    expect((await send("TRANSACTION", obj)).status).toBe(200);
    expect((await billingOf(owner.token)).plan).toBe("pro");
    expect(await prisma.billingPayment.count({ where: { status: "paid" } })).toBe(1);

    const token = {
      id: 17233884,
      token: "0c045bd5330aa3d666d72830d4bcf0e60e10902df9fb2340af978bbf",
      masked_pan: "xxxx-xxxx-xxxx-2346",
      merchant_id: 164295,
      card_subtype: "MasterCard",
      created_at: "2026-11-21T10:44:52.523591",
      email: owner.email,
      order_id: orderId,
    };
    expect((await send("TOKEN", { ...token, token: "forged" }, callbackHmac("TOKEN", token, SECRET))).status).toBe(401);
    expect((await send("TOKEN", token)).status).toBe(200);
    expect((await billingOf(owner.token)).subscription.card).toEqual({ masked: "xxxx-xxxx-xxxx-2346", brand: "MasterCard" });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { companyId: owner.companyId } })).cardToken).toBe(token.token);
  });

  it("a payment for another amount, or for another order, doesn't give the plan", async () => {
    const owner = await ownerSession({ plan: "free" });
    const checkout = (await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "pro" })).body;
    await send("TRANSACTION", transaction(checkout.paymentId, "some-other-order", 29900)).expect(200);
    expect((await paymentsOf(owner.token))[0].status).toBe("pending");
    await send("TRANSACTION", transaction(checkout.paymentId, `test-${checkout.paymentId}`, 100)).expect(200);
    expect((await paymentsOf(owner.token))[0]).toMatchObject({ status: "failed", failureReason: "Amount differs from the price" });
    expect((await billingOf(owner.token)).plan).toBe("free");
  });
});

describe("changing the plan", () => {
  it("a higher plan mid-period costs the difference for the days left, in the same period", async () => {
    const owner = await ownerSession({ plan: "free" });
    const start = addDays(today(), -10);
    const end = addDays(today(), 20);
    await setSubscription(owner.companyId, { plan: "pro", start, end });

    const upgrade = await pay(owner.token, "business");
    // (799 - 299) × 20 / 30
    expect(upgrade).toMatchObject({ kind: "upgrade", amount: "333.33" });
    expect((await billingOf(owner.token)).subscription).toMatchObject({ periodStart: start, periodEnd: end });
    expect((await billingOf(owner.token)).plan).toBe("business");
  });

  it("a lower plan or cancelling waits for the period's end; resume undoes it", async () => {
    const owner = await ownerSession();
    const down = await api().post("/api/billing/downgrade").set(auth(owner.token)).send({ plan: "pro" });
    expect(down.body.billing).toMatchObject({ plan: "business", subscription: { nextPlan: "pro" } });

    const cancel = await api().post("/api/billing/cancel").set(auth(owner.token));
    expect(cancel.body.billing.subscription).toMatchObject({ cancelAtPeriodEnd: true, nextPlan: null });
    expect(cancel.body.billing.plan).toBe("business");

    const resume = await api().post("/api/billing/resume").set(auth(owner.token));
    expect(resume.body.billing.subscription).toMatchObject({ cancelAtPeriodEnd: false, nextPlan: null });

    const free = await ownerSession({ plan: "free" });
    expect((await api().post("/api/billing/cancel").set(auth(free.token))).body.error.code).toBe("NO_SUBSCRIPTION");
  });
});

describe("renewals (the hourly job)", () => {
  it("on the due day the saved card pays the next month (the lower plan if one was chosen)", async () => {
    const owner = await ownerSession({ plan: "free" });
    await setSubscription(owner.companyId, { plan: "business", end: today() });
    await prisma.subscription.update({ where: { companyId: owner.companyId }, data: { nextPlan: "pro" } });

    expect(await runBilling()).toMatchObject({ checked: 1, paid: 1 });
    const billing = await billingOf(owner.token);
    expect(billing).toMatchObject({
      plan: "pro",
      subscription: { status: "active", periodStart: today(), periodEnd: addMonths(today(), 1), nextPlan: null },
    });
    expect((await paymentsOf(owner.token))[0]).toMatchObject({ kind: "renewal", automatic: true, plan: "pro", amount: "299.00", status: "paid" });
    // Nothing more until the next due day.
    expect(await runBilling()).toMatchObject({ checked: 0 });
  });

  it("a declined card is retried a day apart; past the grace days the plan ends and recurring invoices pause", async () => {
    const owner = await ownerSession({ plan: "free" });
    await setSubscription(owner.companyId, { plan: "pro", end: today(), cardToken: `${DECLINED_TEST_CARD}-1` });
    const customer = await customerOf(owner.token);
    expect((await recurring(owner.token, customer.id)).status).toBe(201);

    expect(await runBilling()).toMatchObject({ failed: 1 });
    let billing = await billingOf(owner.token);
    expect(billing).toMatchObject({ plan: "pro", subscription: { status: "pastDue", graceEndsOn: addDays(today(), 7) } });
    // Not again within the day.
    expect(await runBilling()).toMatchObject({ failed: 0, paid: 0 });
    expect(await runBilling(new Date(Date.now() + DAY_MS + 60_000))).toMatchObject({ failed: 1 });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { companyId: owner.companyId } })).renewalAttempts).toBe(2);

    await runBilling(new Date(Date.now() + 8 * DAY_MS));
    billing = await billingOf(owner.token);
    expect(billing).toMatchObject({ plan: "free", subscription: null });
    expect(await prisma.recurringInvoice.count({ where: { companyId: owner.companyId, status: "paused" } })).toBe(1);
    const log = await api().get("/api/audit?action=settings").set(auth(owner.token));
    expect(log.body.items[0]).toMatchObject({ event: "subscriptionEnded", values: { why: "unpaid", count: 1 } });
  });

  it("cancelled: ends on the due day. No saved card: past due until paid by hand, which starts a new month", async () => {
    const cancelled = await ownerSession({ plan: "free" });
    await setSubscription(cancelled.companyId, { end: today(), cancelAtPeriodEnd: true });
    const manual = await ownerSession({ plan: "free" });
    await setSubscription(manual.companyId, { end: today(), cardToken: null });

    await runBilling();
    expect((await billingOf(cancelled.token)).plan).toBe("free");
    expect((await billingOf(manual.token))).toMatchObject({ plan: "pro", subscription: { status: "pastDue" } });
    expect(await prisma.billingPayment.count()).toBe(0);

    const renewal = await pay(manual.token, "pro");
    expect(renewal).toMatchObject({ kind: "renewal", amount: "299.00" });
    expect((await billingOf(manual.token)).subscription).toMatchObject({
      status: "active",
      periodStart: today(),
      periodEnd: addMonths(today(), 1),
    });
  });

  it("an unfinished checkout is given up after two hours", async () => {
    const owner = await ownerSession({ plan: "free" });
    await api().post("/api/billing/checkout").set(auth(owner.token)).send({ plan: "pro" });
    expect(await runBilling(new Date(Date.now() + 3 * 60 * 60 * 1000))).toMatchObject({ expired: 1 });
    expect((await paymentsOf(owner.token))[0]).toMatchObject({ status: "failed", failureReason: "Not completed" });
  });
});

