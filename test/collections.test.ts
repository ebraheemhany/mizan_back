import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { open, seal } from "../src/lib/secret-box.js";
import { callbackHmac } from "../src/modules/billing/paymob.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
// A tiny real PNG (the server checks the file's own bytes, not what the browser says).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PAYMOB = {
  secretKey: "egy_sk_test_0123456789abcdef0123456789abcdef",
  publicKey: "egy_pk_test_ABCDEFGHIJKLMNOP",
  hmacSecret: "0123456789ABCDEF0123456789ABCDEF",
  integrationId: 5676043,
};

/** An owner with a customer and a sent invoice of 1000 + 14% VAT = 1140. */
async function setup() {
  const owner = await ownerSession();
  const customer = (
    await api().post("/api/customers").set(auth(owner.token)).send({ name: "شركة النيل", phone: "01000000000", email: "nile@example.com" })
  ).body.customer;
  const makeInvoice = async (send = true) => {
    const created = (
      await api()
        .post("/api/invoices")
        .set(auth(owner.token))
        .send({ customerId: customer.id, issueDate: today(), terms: 30, send, items: [{ description: "x", quantity: "1", unitPrice: "1000" }] })
    ).body.invoice;
    const detail = (await api().get(`/api/invoices/${created.number}`).set(auth(owner.token))).body.invoice;
    return { number: created.number as number, id: created.id as string, token: detail.publicToken as string | null };
  };
  return { owner, customer, invoice: await makeInvoice(), makeInvoice };
}

const publicPage = (token: string) => api().get(`/api/public/invoices/${token}`);

const claim = (token: string, query: Record<string, string> = {}, body: Buffer | null = PNG) => {
  const req = api()
    .post(`/api/public/invoices/${token}/claims`)
    .query({ amount: "500", date: today(), method: "instapay", reference: "IPN-12345", payerName: "أحمد", ...query })
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", encodeURIComponent("إيصال.png"));
  return body ? req.send(body) : req;
};

/** Fakes Paymob's API: every intention gets this order id. */
function fakePaymob(answer: (url: string) => Response | null = () => null, orderId = 777) {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.includes("paymob.com")) return real(input, init);
    return answer(url) ?? Response.json({ id: "pi_test", client_secret: "csk_test_secret", intention_order_id: orderId });
  });
}

async function connect(ownerToken: string) {
  fakePaymob();
  const res = await api().put("/api/payment-setup/paymob").set(auth(ownerToken)).send(PAYMOB);
  vi.restoreAllMocks();
  return res;
}

describe("secret box", () => {
  it("seals and opens a value, never storing it in the clear", () => {
    const sealed = seal("egy_sk_test_secret");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("egy_sk_test_secret");
    expect(open(sealed)).toBe("egy_sk_test_secret");
    expect(seal("x")).not.toBe(seal("x"));
  });

  it("refuses a sealed value that was tampered with", () => {
    const sealed = seal("secret");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("other").toString("base64url");
    expect(() => open(parts.join("."))).toThrow();
  });
});

describe("payment setup (Settings)", () => {
  it("saves the transfer details for the owner; everyone can read them, only the owner changes them", async () => {
    const { owner } = await setup();
    const empty = await api().get("/api/payment-setup").set(auth(owner.token));
    expect(empty.body.setup).toMatchObject({ transfer: { bankName: null }, paymob: { connected: false } });

    const saved = await api()
      .put("/api/payment-setup/transfer")
      .set(auth(owner.token))
      .send({ bankName: "البنك الأهلي", accountName: "شركة الأمل", accountNumber: "EG38 0019 0005", instapayAddress: "alamal@instapay", walletNumber: "01012345678", instructions: "" });
    expect(saved.status).toBe(200);
    expect(saved.body.setup.transfer).toMatchObject({ bankName: "البنك الأهلي", instapayAddress: "alamal@instapay", instructions: null });

    const accountant = await teamMember(owner.token, "accountant");
    expect((await api().get("/api/payment-setup").set(auth(accountant.token))).body.setup.transfer.bankName).toBe("البنك الأهلي");
    const denied = await api().put("/api/payment-setup/transfer").set(auth(accountant.token)).send({ bankName: "x" });
    expect(denied.status).toBe(403);
  });

  it("rejects a malformed account or wallet number", async () => {
    const { owner } = await setup();
    const res = await api().put("/api/payment-setup/transfer").set(auth(owner.token)).send({ accountNumber: "<script>", walletNumber: "abc" });
    expect(res.status).toBe(400);
  });

  it("connects Paymob after Paymob accepts the keys, and keeps the secrets encrypted and out of answers", async () => {
    const { owner } = await setup();
    const fetchSpy = fakePaymob();
    const res = await api().put("/api/payment-setup/paymob").set(auth(owner.token)).send(PAYMOB);
    expect(res.status).toBe(200);
    expect(res.body.setup.paymob).toMatchObject({ connected: true, live: false, publicKey: PAYMOB.publicKey, integrationId: PAYMOB.integrationId });
    expect(JSON.stringify(res.body)).not.toContain(PAYMOB.secretKey);
    expect(JSON.stringify(res.body)).not.toContain(PAYMOB.hmacSecret);

    // The check: a 1 EGP intention on the company's own account.
    const [, init] = fetchSpy.mock.calls.find(([url]) => String(url).includes("/v1/intention/"))!;
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Token ${PAYMOB.secretKey}`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ amount: 100, payment_methods: [PAYMOB.integrationId] });

    const row = await prisma.paymentSetup.findUniqueOrThrow({ where: { companyId: owner.companyId } });
    expect(row.paymobSecretKey).not.toBe(PAYMOB.secretKey);
    expect(open(row.paymobSecretKey!)).toBe(PAYMOB.secretKey);
    expect(open(row.paymobHmacSecret!)).toBe(PAYMOB.hmacSecret);
  });

  it("says which key is wrong when Paymob refuses them", async () => {
    const { owner } = await setup();
    fakePaymob(() => Response.json({ detail: "Invalid token" }, { status: 401 }));
    const secret = await api().put("/api/payment-setup/paymob").set(auth(owner.token)).send(PAYMOB);
    expect(secret.body.error.code).toBe("PAYMOB_SECRET_INVALID");
    vi.restoreAllMocks();

    fakePaymob(() => Response.json({ detail: "Integration ID/Name does not exist in our system" }, { status: 404 }));
    const integration = await api().put("/api/payment-setup/paymob").set(auth(owner.token)).send(PAYMOB);
    expect(integration.body.error.code).toBe("PAYMOB_INTEGRATION_INVALID");
    expect((await api().get("/api/payment-setup").set(auth(owner.token))).body.setup.paymob.connected).toBe(false);
  });

  it("refuses test and live keys mixed together", async () => {
    const { owner } = await setup();
    const res = await api()
      .put("/api/payment-setup/paymob")
      .set(auth(owner.token))
      .send({ ...PAYMOB, publicKey: "egy_pk_live_ABCDEFGHIJKLMNOP" });
    expect(res.status).toBe(400);
  });

  it("disconnects Paymob", async () => {
    const { owner } = await setup();
    await connect(owner.token);
    const res = await api().delete("/api/payment-setup/paymob").set(auth(owner.token));
    expect(res.body.setup.paymob.connected).toBe(false);
    const row = await prisma.paymentSetup.findUniqueOrThrow({ where: { companyId: owner.companyId } });
    expect(row.paymobSecretKey).toBeNull();
  });
});

describe("the invoice link: how to pay", () => {
  it("shows what is owed, the transfer details once set, and card payment once Paymob is connected", async () => {
    const { owner, invoice } = await setup();
    const before = (await publicPage(invoice.token!)).body.pay;
    expect(before).toEqual({ payable: true, remaining: "1140.00", online: null, transfer: null, claims: [] });

    await api().put("/api/payment-setup/transfer").set(auth(owner.token)).send({ instapayAddress: "alamal@instapay" });
    await connect(owner.token);
    const after = (await publicPage(invoice.token!)).body.pay;
    expect(after.transfer).toMatchObject({ instapayAddress: "alamal@instapay", bankName: null });
    expect(after.online).toEqual({ test: true });
  });

  it("offers no card payment when the company's currency isn't EGP", async () => {
    const { owner, invoice } = await setup();
    await connect(owner.token);
    await prisma.company.update({ where: { id: owner.companyId }, data: { currency: "USD" } });
    expect((await publicPage(invoice.token!)).body.pay.online).toBeNull();
    const checkout = await api().post(`/api/public/invoices/${invoice.token}/checkout`).send({ locale: "ar" });
    expect(checkout.body.error.code).toBe("ONLINE_PAYMENT_UNAVAILABLE");
  });
});

describe("receipts customers send", () => {
  it("records nothing until reviewed: the claim, its receipt and the invoice's history", async () => {
    const { owner, invoice } = await setup();
    const res = await claim(invoice.token!);
    expect(res.status).toBe(201);
    expect(res.body.claim).toMatchObject({ amount: "500.00", method: "instapay", status: "pending" });

    const detail = (await api().get(`/api/invoices/${invoice.number}`).set(auth(owner.token))).body.invoice;
    expect(detail.remaining).toBe("1140.00");
    expect(detail.payments).toHaveLength(0);
    expect(detail.claims[0]).toMatchObject({ amount: "500.00", reference: "IPN-12345", payerName: "أحمد", status: "pending", receipt: { contentType: "image/png", name: "إيصال.png" } });
    expect(detail.history[0]).toMatchObject({ type: "paymentClaimed" });

    const list = await api().get("/api/payment-claims").set(auth(owner.token));
    expect(list.body.items[0]).toMatchObject({ status: "pending", invoice: { number: invoice.number, customer: "شركة النيل" } });

    const receipt = await api().get(`/api/payment-claims/${list.body.items[0].id}/receipt`).set(auth(owner.token));
    expect(receipt.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(receipt.body).equals(PNG)).toBe(true);

    expect((await publicPage(invoice.token!)).body.pay.claims[0]).toMatchObject({ status: "pending", amount: "500.00" });
  });

  it("needs a receipt that really is an image or a PDF", async () => {
    const { invoice } = await setup();
    expect((await claim(invoice.token!, {}, null)).body.error.code).toBe("FILE_EMPTY");
    expect((await claim(invoice.token!, {}, Buffer.from("<html>hi</html>"))).body.error.code).toBe("FILE_TYPE");
  });

  it("checks the amount, the date and the method", async () => {
    const { invoice } = await setup();
    expect((await claim(invoice.token!, { amount: "2000" })).body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect((await claim(invoice.token!, { date: addDays(today(), 1) })).body.error.code).toBe("PAYMENT_DATE_IN_FUTURE");
    expect((await claim(invoice.token!, { date: addDays(today(), -1) })).body.error.code).toBe("PAYMENT_BEFORE_ISSUE");
    expect((await claim(invoice.token!, { method: "cash" })).status).toBe(400);
    expect((await claim(invoice.token!, { amount: "0" })).status).toBe(400);
  });

  it("keeps at most three receipts waiting on one invoice", async () => {
    const { invoice } = await setup();
    for (let i = 0; i < 3; i++) expect((await claim(invoice.token!, { amount: "100" })).status).toBe(201);
    expect((await claim(invoice.token!, { amount: "100" })).body.error.code).toBe("CLAIMS_LIMIT");
  });

  it("can't be sent on a paid or cancelled invoice, or on an unknown link", async () => {
    const { owner, invoice, makeInvoice } = await setup();
    await api().post(`/api/invoices/${invoice.number}/payments`).set(auth(owner.token)).send({ amount: "1140", date: today(), method: "cash" });
    expect((await claim(invoice.token!)).body.error.code).toBe("INVOICE_NOT_PAYABLE");

    const other = await makeInvoice();
    await api().post(`/api/invoices/${other.number}/cancel`).set(auth(owner.token));
    expect((await claim(other.token!)).body.error.code).toBe("INVOICE_NOT_PAYABLE");

    expect((await claim("x".repeat(43))).status).toBe(404);
  });

  it("accepting records the payment with the receipt as its proof, once", async () => {
    const { owner, invoice } = await setup();
    const sent = (await claim(invoice.token!)).body.claim;
    const accountant = await teamMember(owner.token, "accountant");

    const res = await api().post(`/api/payment-claims/${sent.id}/accept`).set(auth(accountant.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe("accepted");

    const detail = (await api().get(`/api/invoices/${invoice.number}`).set(auth(owner.token))).body.invoice;
    expect(detail.remaining).toBe("640.00");
    expect(detail.status).toBe("partial");
    expect(detail.payments[0]).toMatchObject({ amount: "500.00", method: "instapay", reference: "IPN-12345", account: "bank", hasProof: true, source: "claim" });
    expect(detail.claims).toHaveLength(0);

    const proof = await api().get(`/api/payments/${detail.payments[0].id}/proof`).set(auth(owner.token));
    expect(Buffer.from(proof.body).equals(PNG)).toBe(true);

    const again = await api().post(`/api/payment-claims/${sent.id}/accept`).set(auth(owner.token)).send({});
    expect(again.body.error.code).toBe("CLAIM_ALREADY_REVIEWED");
    expect(await prisma.invoicePayment.count()).toBe(1);
  });

  it("puts a wallet transfer in the wallet unless told otherwise", async () => {
    const { owner, invoice } = await setup();
    const wallet = (await claim(invoice.token!, { method: "vodafoneCash", amount: "100" })).body.claim;
    const bank = (await claim(invoice.token!, { method: "bank", amount: "100" })).body.claim;
    await api().post(`/api/payment-claims/${wallet.id}/accept`).set(auth(owner.token)).send({});
    await api().post(`/api/payment-claims/${bank.id}/accept`).set(auth(owner.token)).send({ account: "cashbox" });
    const accounts = (await prisma.invoicePayment.findMany({ orderBy: { number: "asc" } })).map((p) => p.account);
    expect(accounts).toEqual(["wallet", "cashbox"]);
  });

  it("can't be reviewed by sales or a viewer", async () => {
    const { owner, invoice } = await setup();
    const sent = (await claim(invoice.token!)).body.claim;
    const sales = await teamMember(owner.token, "sales");
    expect((await api().post(`/api/payment-claims/${sent.id}/accept`).set(auth(sales.token)).send({})).status).toBe(403);
    expect((await api().post(`/api/payment-claims/${sent.id}/reject`).set(auth(sales.token)).send({ reason: "لا" })).status).toBe(403);
  });

  it("rejecting tells the customer why, and leaves the invoice as it was", async () => {
    const { owner, invoice } = await setup();
    const sent = (await claim(invoice.token!)).body.claim;
    const res = await api().post(`/api/payment-claims/${sent.id}/reject`).set(auth(owner.token)).send({ reason: "المبلغ ما وصلش الحساب" });
    expect(res.body.claim).toMatchObject({ status: "rejected", rejectReason: "المبلغ ما وصلش الحساب" });
    expect((await publicPage(invoice.token!)).body.pay.claims[0]).toMatchObject({ status: "rejected", rejectReason: "المبلغ ما وصلش الحساب" });
    const detail = (await api().get(`/api/invoices/${invoice.number}`).set(auth(owner.token))).body.invoice;
    expect(detail.remaining).toBe("1140.00");
    expect(detail.history[0]).toMatchObject({ type: "paymentClaimRejected" });
    const accept = await api().post(`/api/payment-claims/${sent.id}/accept`).set(auth(owner.token)).send({});
    expect(accept.body.error.code).toBe("CLAIM_ALREADY_REVIEWED");
  });

  it("goes back to waiting when its payment is removed", async () => {
    const { owner, invoice } = await setup();
    const sent = (await claim(invoice.token!)).body.claim;
    await api().post(`/api/payment-claims/${sent.id}/accept`).set(auth(owner.token)).send({});
    const payment = await prisma.invoicePayment.findFirstOrThrow();
    expect((await api().delete(`/api/payments/${payment.id}`).set(auth(owner.token))).status).toBe(204);
    const row = await prisma.paymentClaim.findUniqueOrThrow({ where: { id: sent.id } });
    expect(row).toMatchObject({ status: "pending", paymentId: null });
    // Its receipt is still there to review.
    expect((await api().get(`/api/payment-claims/${sent.id}/receipt`).set(auth(owner.token))).status).toBe(200);
  });
});

describe("proof on a payment staff record", () => {
  it("attaches, serves and replaces it; removing the payment removes the file", async () => {
    const { owner, invoice } = await setup();
    const recorded = await api().post(`/api/invoices/${invoice.number}/payments`).set(auth(owner.token)).send({ amount: "100", date: today(), method: "bank" });
    expect(recorded.status).toBe(201);
    const paymentId = recorded.body.paymentId as string;
    expect(paymentId).toBeTruthy();

    const up = await api().put(`/api/payments/${paymentId}/proof`).set(auth(owner.token)).set("Content-Type", "image/png").send(PNG);
    expect(up.status).toBe(200);
    const again = await api().put(`/api/payments/${paymentId}/proof`).set(auth(owner.token)).set("Content-Type", "image/png").send(PNG);
    expect(again.status).toBe(200);
    expect(await prisma.storedFile.count({ where: { kind: "receipt" } })).toBe(1);
    expect((await api().get(`/api/payments/${paymentId}/proof`).set(auth(owner.token))).status).toBe(200);

    const viewer = await teamMember(owner.token, "viewer");
    expect((await api().put(`/api/payments/${paymentId}/proof`).set(auth(viewer.token)).set("Content-Type", "image/png").send(PNG)).status).toBe(403);

    await api().delete(`/api/payments/${paymentId}`).set(auth(owner.token));
    expect(await prisma.storedFile.count({ where: { kind: "receipt" } })).toBe(0);
  });
});

describe("card payments on the invoice link (the company's own Paymob)", () => {
  /** A TRANSACTION callback as Paymob sends it, signed with the company's HMAC secret. */
  function callback(companyId: string, fields: Record<string, unknown>, secret = PAYMOB.hmacSecret) {
    const obj = {
      id: 9001,
      amount_cents: 114000,
      created_at: "2026-11-25T10:00:00",
      currency: "EGP",
      error_occured: false,
      has_parent_transaction: false,
      integration_id: PAYMOB.integrationId,
      is_3d_secure: true,
      is_auth: false,
      is_capture: false,
      is_refunded: false,
      is_standalone_payment: true,
      is_voided: false,
      order: { id: 777 },
      owner: 1,
      pending: false,
      source_data: { pan: "2346", sub_type: "MasterCard", type: "card" },
      success: true,
      ...fields,
    };
    return api()
      .post(`/api/public/paymob/invoices/${companyId}`)
      .query({ hmac: callbackHmac("TRANSACTION", obj, secret) })
      .send({ type: "TRANSACTION", obj });
  }

  async function startCheckout() {
    const ctx = await setup();
    await connect(ctx.owner.token);
    const fetchSpy = fakePaymob();
    const res = await api().post(`/api/public/invoices/${ctx.invoice.token}/checkout`).send({ locale: "en" });
    const [, init] = fetchSpy.mock.calls.find(([url]) => String(url).includes("/v1/intention/"))!;
    vi.restoreAllMocks();
    return { ...ctx, res, intention: JSON.parse(init!.body as string) };
  }

  it("starts a checkout for what is owed, on the company's own account", async () => {
    const { owner, invoice, res, intention } = await startCheckout();
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get("publicKey")).toBe(PAYMOB.publicKey);
    expect(url.searchParams.get("clientSecret")).toBe("csk_test_secret");
    expect(intention).toMatchObject({
      amount: 114000,
      payment_methods: [PAYMOB.integrationId],
      notification_url: expect.stringContaining(`/api/public/paymob/invoices/${owner.companyId}`),
      redirection_url: expect.stringContaining(`/en/i/${invoice.token}?checkout=`),
      billing_data: { first_name: "شركة", last_name: "النيل", email: "nile@example.com" },
    });
    const online = await prisma.onlinePayment.findFirstOrThrow();
    expect(online).toMatchObject({ status: "pending", gatewayOrderId: "777" });
    const status = await api().get(`/api/public/invoices/${invoice.token}/checkout/${online.id}`);
    expect(status.body).toEqual({ status: "pending", amount: "1140.00" });
  });

  it("records the payment when Paymob says it's paid, once, with nobody's name on it", async () => {
    const { owner, invoice } = await startCheckout();
    expect((await callback(owner.companyId, {})).status).toBe(200);
    // Paymob sends a callback more than once sometimes.
    expect((await callback(owner.companyId, {})).status).toBe(200);

    const detail = (await api().get(`/api/invoices/${invoice.number}`).set(auth(owner.token))).body.invoice;
    expect(detail.status).toBe("paid");
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]).toMatchObject({ amount: "1140.00", method: "card", reference: "9001", source: "online", account: "bank" });
    const payment = await prisma.invoicePayment.findFirstOrThrow();
    expect(payment.createdById).toBeNull();
    const online = await prisma.onlinePayment.findFirstOrThrow();
    expect(online).toMatchObject({ status: "paid", transactionId: "9001", paymentId: payment.id });
    expect((await api().get(`/api/public/invoices/${invoice.token}/checkout/${online.id}`)).body.status).toBe("paid");
  });

  it("refuses a callback signed with another secret", async () => {
    const { owner } = await startCheckout();
    const res = await callback(owner.companyId, {}, "not-the-company-secret-0000000000");
    expect(res.status).toBe(401);
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("marks a declined payment as failed and records nothing", async () => {
    const { owner } = await startCheckout();
    await callback(owner.companyId, { success: false, data: { message: "Insufficient funds" } });
    expect(await prisma.onlinePayment.findFirstOrThrow()).toMatchObject({ status: "failed", failureReason: "Insufficient funds" });
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("doesn't record a charge for a different amount", async () => {
    const { owner } = await startCheckout();
    await callback(owner.companyId, { amount_cents: 100 });
    expect(await prisma.onlinePayment.findFirstOrThrow()).toMatchObject({ status: "paid", failureReason: "AMOUNT_MISMATCH", paymentId: null });
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("keeps a payment that can't be recorded any more (paid another way meanwhile) for someone to sort out", async () => {
    const { owner, invoice } = await startCheckout();
    await api().post(`/api/invoices/${invoice.number}/payments`).set(auth(owner.token)).send({ amount: "1140", date: today(), method: "cash" });
    expect((await callback(owner.companyId, {})).status).toBe(200);
    expect(await prisma.onlinePayment.findFirstOrThrow()).toMatchObject({ status: "paid", failureReason: "INVOICE_NOT_PAYABLE", paymentId: null });
    expect(await prisma.invoicePayment.count()).toBe(1);
  });

  it("can't be started without a connected account", async () => {
    const { invoice } = await setup();
    const res = await api().post(`/api/public/invoices/${invoice.token}/checkout`).send({ locale: "ar" });
    expect(res.body.error.code).toBe("ONLINE_PAYMENT_UNAVAILABLE");
  });
});
