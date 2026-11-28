// E-invoicing with ETA, end to end against the mock ETA (test/eta-mock.ts): the setup,
// what's missing before sending, sending invoices and credit notes, ETA's verdicts,
// cancelling there, and the guards in Mizan.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { businessToday } from "../src/lib/dates.js";
import { etaCanonical } from "../src/modules/eta/eta.canonical.js";
import { MOCK_CLIENT, etaChecks, startEtaMock } from "./eta-mock.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

let mock: Awaited<ReturnType<typeof startEtaMock>>;
beforeAll(async () => {
  mock = await startEtaMock();
});
afterAll(async () => {
  await mock.close();
  await prisma.$disconnect();
});
beforeEach(resetDatabase);

const today = () => businessToday();
async function ok<T = any>(res: { status: number; body: any }, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const SETUP = {
  clientId: MOCK_CLIENT.id,
  clientSecret: MOCK_CLIENT.secret,
  activityCode: "6201",
  governorate: "القاهرة",
  regionCity: "مدينة نصر",
  street: "عباس العقاد",
  buildingNumber: "12",
  defaultCodeType: "EGS",
  defaultCode: "EG-123456789-SERVICES",
  defaultUnit: "EA",
};

/** A company ready for ETA: tax number, the link, a customer (a business) and a coded product. */
async function ready(token: string, customer: Record<string, unknown> = {}) {
  await prisma.company.updateMany({ data: { taxNumber: "123-456-789" } });
  await ok(await api().put("/api/eta/setup").set(auth(token)).send(SETUP));
  const c = (
    await ok(
      await api()
        .post("/api/customers")
        .set(auth(token))
        .send({ name: "شركة النيل", taxNumber: "987654321", city: "الدقي", governorate: "الجيزة", street: "التحرير", buildingNumber: "5", ...customer }),
      201,
    )
  ).customer;
  const product = (
    await ok(
      await api()
        .post("/api/products")
        .set(auth(token))
        .send({ name: "كرسي مكتب", type: "product", code: "PRD-001", price: "200", taxRate: "14", category: "devices", stock: "10", etaCodeType: "EGS", etaCode: "EG-123456789-CHAIR", etaUnit: "EA" }),
      201,
    )
  ).product;
  return { customerId: c.id as string, productId: product.id as string };
}

const invoice = async (token: string, customerId: string, items: Record<string, unknown>[]) =>
  (await ok(await api().post("/api/invoices").set(auth(token)).send({ customerId, issueDate: today(), terms: 30, send: true, items }), 201)).invoice;
const submit = (token: string, number: number) => api().post(`/api/eta/invoices/${number}/submit`).set(auth(token));
const state = async (token: string, number: number) => ok(await api().get(`/api/eta/invoices/${number}`).set(auth(token)));

describe("ETA setup", () => {
  it("the owner saves the link (the secret is never shown), checks it with ETA; others can't", async () => {
    const { token } = await ownerSession();
    const empty = (await ok(await api().get("/api/eta/setup").set(auth(token)))).setup;
    expect(empty).toMatchObject({ environment: "preprod", clientId: null, hasSecret: false, branchId: "0", defaultUnit: "EA", signingAvailable: false });

    const saved = (await ok(await api().put("/api/eta/setup").set(auth(token)).send(SETUP))).setup;
    expect(saved).toMatchObject({ clientId: "test-client", hasSecret: true, activityCode: "6201", verifiedAt: null });
    expect(JSON.stringify(saved)).not.toContain(MOCK_CLIENT.secret);
    const row = await prisma.etaSetup.findFirstOrThrow();
    expect(row.clientSecret).not.toContain(MOCK_CLIENT.secret);

    const verified = (await ok(await api().post("/api/eta/setup/verify").set(auth(token)))).setup;
    expect(verified.verifiedAt).toBeTruthy();

    // A wrong secret: ETA says no, and the check is reset.
    await ok(await api().put("/api/eta/setup").set(auth(token)).send({ clientSecret: "nope" }));
    const bad = await api().post("/api/eta/setup/verify").set(auth(token));
    expect(bad.body.error.code).toBe("ETA_BAD_CREDENTIALS");
    // Not ETA codes.
    expect((await api().put("/api/eta/setup").set(auth(token)).send({ activityCode: "9999" })).status).toBe(400);
    expect((await api().put("/api/eta/setup").set(auth(token)).send({ defaultUnit: "MTR" })).status).toBe(400);

    const accountant = await teamMember(token, "accountant");
    expect((await api().get("/api/eta/setup").set(auth(accountant.token))).status).toBe(403);
  });
});

describe("sending invoices to ETA", () => {
  it("lists what's missing first, and refuses to send until it's fixed", async () => {
    const { token } = await ownerSession();
    const customer = (await ok(await api().post("/api/customers").set(auth(token)).send({ name: "شركة", taxNumber: "111" }), 201)).customer;
    const inv = await invoice(token, customer.id, [{ description: "خدمة", quantity: "1", unitPrice: "100" }]);
    const before = await state(token, inv.number);
    expect(before.configured).toBe(false);
    expect(before.problems.map((p: { code: string }) => p.code).sort()).toEqual(
      ["ACTIVITY_CODE", "CUSTOMER_ADDRESS", "CUSTOMER_TAX_NUMBER", "ISSUER_ADDRESS", "LINE_CODE", "SETUP_CREDENTIALS", "TAX_NUMBER"].sort(),
    );
    const refused = await submit(token, inv.number);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("ETA_NOT_READY");
    expect(refused.body.error.details.problems).toEqual(expect.arrayContaining([{ code: "LINE_CODE", line: 1, description: "خدمة", productId: null }]));
    expect(mock.received).toHaveLength(0);
  });

  it("sends a valid invoice: ETA's structure and math hold, it's registered, and can't be sent twice or cancelled here", async () => {
    const { token } = await ownerSession();
    const { customerId, productId } = await ready(token);
    const tokensBefore = mock.tokenCalls();
    const inv = await invoice(token, customerId, [
      { description: "كرسي مكتب", quantity: "3", unitPrice: "150", productId },
      { description: "تركيب", quantity: "2.5", unitPrice: "34.58" },
    ]);
    const sent = (await ok(await submit(token, inv.number))).eta;
    expect(sent).toMatchObject({ status: "valid", environment: "preprod", internalId: inv.displayNumber, total: "611.553", errors: [] });
    expect(sent.publicUrl).toMatch(/^https:\/\/preprod\.invoicing\.eta\.gov\.eg\/documents\/\w+\/share\/\w+$/);

    // What ETA got: valid by its rules; our numbers as sent; canonical form computable.
    const doc = mock.received.at(-1)!;
    expect(etaChecks(doc)).toEqual([]);
    expect(doc).toMatchObject({
      documentType: "I",
      documentTypeVersion: "0.9",
      internalID: inv.displayNumber,
      taxpayerActivityCode: "6201",
      issuer: { type: "B", id: "123456789", address: { branchID: "0", country: "EG", governate: "القاهرة" } },
      receiver: { type: "B", id: "987654321", name: "شركة النيل", address: { regionCity: "الدقي" } },
      totalAmount: 611.553,
    });
    expect(doc.invoiceLines[0]).toMatchObject({ itemType: "EGS", itemCode: "EG-123456789-CHAIR", internalCode: "PRD-001", quantity: 3 });
    // The free-text line goes under the company's default code.
    expect(doc.invoiceLines[1]).toMatchObject({ itemCode: "EG-123456789-SERVICES", unitType: "EA", salesTotal: 86.45 });
    expect(etaCanonical(doc)).toContain('"INTERNALID""' + inv.displayNumber + '"');

    expect((await submit(token, inv.number)).body.error.code).toBe("ETA_ALREADY_SUBMITTED");
    expect((await api().post(`/api/invoices/${inv.number}/cancel`).set(auth(token))).body.error.code).toBe("ETA_DOCUMENT_ACTIVE");
    // At most one new token for all of it (cached for its hour).
    expect(mock.tokenCalls() - tokensBefore).toBeLessThanOrEqual(1);
    const log = await ok(await api().get("/api/audit").set(auth(token)));
    expect(JSON.stringify(log)).toContain("etaInvoiceSent");
  });

  it("ETA's verdicts: refused at submission, or invalid after its checks, with the reasons; then it can go again", async () => {
    const { token } = await ownerSession();
    const { customerId } = await ready(token, { name: "REJECT ME" });
    const inv = await invoice(token, customerId, [{ description: "خدمة", quantity: "1", unitPrice: "100" }]);
    const rejected = (await ok(await submit(token, inv.number))).eta;
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors[0]).toMatchObject({ code: "CF001", message: "receiver refused" });

    // An item code ETA doesn't know: accepted, then invalid, with ETA's Arabic reason.
    await prisma.customer.updateMany({ data: { name: "شركة النيل" } });
    await prisma.invoice.updateMany({ data: { customerName: "شركة النيل" } });
    await ok(await api().put("/api/eta/setup").set(auth(token)).send({ defaultCode: "EG-123456789-INVALID" }));
    const invalid = (await ok(await submit(token, inv.number))).eta;
    expect(invalid.status).toBe("invalid");
    expect(invalid.errors).toEqual([{ code: "CodeValidator", message: "كود الصنف غير مسجل", path: "invoiceLines[0].itemCode" }]);

    await ok(await api().put("/api/eta/setup").set(auth(token)).send({ defaultCode: "EG-123456789-SERVICES" }));
    expect((await ok(await submit(token, inv.number))).eta.status).toBe("valid");
    expect(await prisma.etaSubmission.count()).toBe(3);
  });

  it("a person: no national ID needed under ETA's limit, required from it (25,000 with VAT)", async () => {
    const { token } = await ownerSession();
    const { customerId } = await ready(token, { taxNumber: "", etaType: "P", name: "أحمد علي" });
    const small = await invoice(token, customerId, [{ description: "خدمة", quantity: "1", unitPrice: "1000" }]);
    expect((await ok(await submit(token, small.number))).eta.status).toBe("valid");
    expect(mock.received.at(-1)!.receiver).toMatchObject({ type: "P", name: "أحمد علي" });
    expect(mock.received.at(-1)!.receiver.id).toBeUndefined();

    const big = await invoice(token, customerId, [{ description: "خدمة", quantity: "1", unitPrice: "22000" }]);
    expect((await state(token, big.number)).problems).toEqual([{ code: "CUSTOMER_NATIONAL_ID", customerId }]);
    await ok(await api().patch(`/api/customers/${customerId}`).set(auth(token)).send({ nationalId: "29001011234567" }));
    expect((await ok(await submit(token, big.number))).eta.status).toBe("valid");
    expect(mock.received.at(-1)!.receiver.id).toBe("29001011234567");
  });

  it("production needs signing (not yet); a non-EGP company can't send", async () => {
    const { token } = await ownerSession();
    const { customerId } = await ready(token);
    const inv = await invoice(token, customerId, [{ description: "خدمة", quantity: "1", unitPrice: "100" }]);
    await ok(await api().put("/api/eta/setup").set(auth(token)).send({ environment: "production" }));
    await prisma.company.updateMany({ data: { currency: "USD" } });
    const codes = (await state(token, inv.number)).problems.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["SIGNING", "CURRENCY"]));
  });
});

describe("credit notes and cancelling at ETA", () => {
  it("a credit note goes after its invoice, pointing at it with the same items; cancelling follows ETA's order", async () => {
    const { token } = await ownerSession();
    const { customerId, productId } = await ready(token);
    const inv = await invoice(token, customerId, [{ description: "كرسي مكتب", quantity: "4", unitPrice: "200", productId }]);
    const note = (
      await ok(
        await api()
          .post(`/api/invoices/${inv.number}/credit-notes`)
          .set(auth(token))
          .send({ date: today(), reason: "return", lines: [{ description: "كرسي مكتب", quantity: "1", unitPrice: "200", productId }] }),
        201,
      )
    ).invoice.creditNotes[0];
    const noteUrl = `/api/eta/invoices/${inv.number}/credit-notes/${note.id}`;

    // Not before the invoice is at ETA.
    expect((await state(token, inv.number)).creditNotes[0].problems).toEqual([{ code: "INVOICE_NOT_AT_ETA" }]);
    const invoiceEta = (await ok(await submit(token, inv.number))).eta;

    const sent = (await ok(await api().post(`${noteUrl}/submit`).set(auth(token)))).eta;
    expect(sent).toMatchObject({ status: "valid", internalId: "CN-0001", total: "228" });
    const doc = mock.received.at(-1)!;
    expect(etaChecks(doc)).toEqual([]);
    expect(doc).toMatchObject({ documentType: "C", references: [invoiceEta.uuid], receiver: mock.received.at(-2)!.receiver });
    expect(doc.invoiceLines[0]).toMatchObject({ itemCode: "EG-123456789-CHAIR", quantity: 1 });

    // Mizan won't delete it while it's at ETA; ETA won't cancel the invoice while the note stands.
    expect((await api().delete(`/api/invoices/${inv.number}/credit-notes/${note.id}`).set(auth(token))).body.error.code).toBe("ETA_DOCUMENT_ACTIVE");
    const blocked = await api().post(`/api/eta/invoices/${inv.number}/cancel`).set(auth(token)).send({ reason: "details" });
    expect(blocked.body.error.code).toBe("ETA_CANCEL_HAS_CREDIT_NOTES");

    expect((await ok(await api().post(`${noteUrl}/cancel`).set(auth(token)).send({ reason: "details" }))).eta.status).toBe("cancelled");
    const cancelled = (await ok(await api().post(`/api/eta/invoices/${inv.number}/cancel`).set(auth(token)).send({ reason: "buyer" }))).eta;
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled.cancelRequestedAt).toBeTruthy();
    // Now Mizan can take them back too.
    await ok(await api().delete(`/api/invoices/${inv.number}/credit-notes/${note.id}`).set(auth(token)));
    await ok(await api().post(`/api/invoices/${inv.number}/cancel`).set(auth(token)));

    const accountant = await teamMember(token, "sales");
    expect((await api().post(`/api/eta/invoices/${inv.number}/submit`).set(auth(accountant.token))).status).toBe(403);
  });
});
