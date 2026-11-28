import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function ok<T = any>(res: { status: number; body: any }, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A customer and an issued invoice: 5 x 200 = 1000 + 14% VAT = 1140. */
async function invoiceOf(token: string) {
  const customer = (await ok(await api().post("/api/customers").set(auth(token)).send({ name: "شركة النيل" }), 201)).customer;
  const created = (
    await ok(
      await api()
        .post("/api/invoices")
        .set(auth(token))
        .send({ customerId: customer.id, issueDate: today(), terms: 30, send: true, items: [{ description: "كرسي مكتب", quantity: "5", unitPrice: "200" }] }),
      201,
    )
  ).invoice;
  return { customerId: customer.id as string, number: created.number as number };
}

const detail = async (token: string, number: number) => (await ok(await api().get(`/api/invoices/${number}`).set(auth(token)))).invoice;
const creditRequest = (token: string, number: number, body: Record<string, unknown> = {}) =>
  api()
    .post(`/api/invoices/${number}/credit-notes`)
    .set(auth(token))
    .send({ date: today(), reason: "return", lines: [{ description: "كرسي مكتب (مرتجع)", quantity: "1", unitPrice: "200" }], ...body });
const pay = (token: string, number: number, amount: string) =>
  api().post(`/api/invoices/${number}/payments`).set(auth(token)).send({ amount, date: today(), method: "cash", account: "cashbox" });
const entries = async (token: string) =>
  (await ok(await api().get("/api/ledger/entries?pageSize=100&source=invoice").set(auth(token)))).items as {
    source: string;
    ref: string | null;
    lines: { key: string | null; debit: string; credit: string }[];
  }[];
const linesOf = (e: { lines: { key: string | null; debit: string; credit: string }[] }) => e.lines.map((l) => `${l.key} ${l.debit}/${l.credit}`);

describe("credit notes", () => {
  it("a return on an unpaid invoice lowers what's owed; the rest can be paid, no more", async () => {
    const { token } = await ownerSession();
    const { number } = await invoiceOf(token);
    const after = (await ok(await creditRequest(token, number), 201)).invoice;
    // One chair back: 200 + 28 VAT.
    expect(after).toMatchObject({ credited: "228.00", remaining: "912.00", status: "partial" });
    expect(after.creditNotes).toHaveLength(1);
    expect(after.creditNotes[0]).toMatchObject({ number: "CN-0001", subtotal: "200.00", vat: "28.00", total: "228.00", refund: "0.00", reason: "return" });

    expect((await pay(token, number, "913")).body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    await ok(await pay(token, number, "912"), 201);
    expect(await detail(token, number)).toMatchObject({ status: "paid", remaining: "0.00" });

    // The books: Dr sales 200, Dr VAT 28 / Cr customers 228.
    const note = (await entries(token)).find((e) => e.source === "creditNote");
    expect(note && linesOf(note)).toEqual(["sales 200.00/0.00", "vat 28.00/0.00", "customers 0.00/228.00"]);
    expect(note?.ref).toBe("CN-0001");
  });

  it("on a paid invoice, what was paid beyond what's now owed is refunded from the account named", async () => {
    const { token } = await ownerSession();
    const { number, customerId } = await invoiceOf(token);
    await ok(await pay(token, number, "1140"), 201);

    const missing = await creditRequest(token, number);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: "REFUND_ACCOUNT_REQUIRED", details: { refund: "228.00" } });

    const after = (await ok(await creditRequest(token, number, { refundAccount: "bank" }), 201)).invoice;
    expect(after).toMatchObject({ credited: "228.00", remaining: "0.00", status: "paid" });
    expect(after.creditNotes[0]).toMatchObject({ refund: "228.00", refundAccount: "bank" });
    const row = await prisma.invoice.findFirstOrThrow({ where: { number }, select: { amountPaid: true } });
    expect(row.amountPaid.toFixed(2)).toBe("912.00");

    // The refund: Dr customers / Cr bank.
    const refund = (await entries(token)).find((e) => e.source === "creditNoteRefund");
    expect(refund && linesOf(refund)).toEqual(["customers 228.00/0.00", "bank 0.00/228.00"]);

    // The customer's statement: the invoice, the payment, the credit note and the refund; nothing owed.
    const st = (await ok(await api().get(`/api/reports/statement?customerId=${customerId}`).set(auth(token)))).statement;
    expect(st.txns.map((t: { type: string }) => t.type).sort()).toEqual(["creditNote", "invoice", "payment", "refund"]);
    expect(st).toMatchObject({ invoiced: "1140.00", paid: "1140.00", credited: "228.00", refunded: "228.00", closing: "0.00" });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).balance.toFixed(2)).toBe("0.00");
  });

  it("comes off revenue and the VAT on sales", async () => {
    const { token } = await ownerSession();
    const { number } = await invoiceOf(token);
    await ok(await creditRequest(token, number), 201);
    const vat = (await ok(await api().get("/api/reports/vat").set(auth(token)))).vat;
    expect(vat).toMatchObject({ output: "112.00", taxableSales: "800.00", creditNotesCount: 1, creditedVat: "28.00" });
    const summary = (await ok(await api().get("/api/reports/summary").set(auth(token)))).summary;
    expect(JSON.stringify(summary)).toContain("800");
  });

  it("never more than what's left of the invoice; only an issued one; dated between the invoice and today", async () => {
    const { token } = await ownerSession();
    const { number, customerId } = await invoiceOf(token);
    await ok(await creditRequest(token, number, { lines: [{ description: "خصم", quantity: "1", unitPrice: "900" }] }), 201);
    // 1140 - 1026 = 114 left to take back.
    const over = await creditRequest(token, number, { lines: [{ description: "خصم", quantity: "1", unitPrice: "101" }] });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: "CREDIT_EXCEEDS_INVOICE", details: { creditable: "114.00" } });
    expect((await creditRequest(token, number, { date: addDays(today(), 1) })).status).toBe(400);
    expect((await creditRequest(token, number, { date: addDays(today(), -1) })).body.error.code).toBe("CREDIT_NOTE_BEFORE_INVOICE");

    const draft = (
      await ok(
        await api()
          .post("/api/invoices")
          .set(auth(token))
          .send({ customerId, issueDate: today(), terms: 30, items: [{ description: "x", quantity: "1", unitPrice: "100" }] }),
        201,
      )
    ).invoice;
    expect((await creditRequest(token, draft.number)).body.error.code).toBe("INVOICE_NOT_CREDITABLE");
  });

  it("is taken back only by the owner; everything returns to how it was", async () => {
    const { token } = await ownerSession();
    const { number, customerId } = await invoiceOf(token);
    await ok(await pay(token, number, "1140"), 201);
    const note = (await ok(await creditRequest(token, number, { refundAccount: "cashbox" }), 201)).invoice.creditNotes[0];
    const accountant = await teamMember(token, "accountant");
    expect((await api().delete(`/api/invoices/${number}/credit-notes/${note.id}`).set(auth(accountant.token))).status).toBe(403);
    // The accountant can issue one, though.
    expect((await creditRequest(accountant.token, number, { refundAccount: "cashbox" })).status).toBe(201);

    const back = (await ok(await api().delete(`/api/invoices/${number}/credit-notes/${note.id}`).set(auth(token)))).invoice;
    expect(back.creditNotes).toHaveLength(1);
    expect(back).toMatchObject({ credited: "228.00", status: "paid" });
    const row = await prisma.invoice.findFirstOrThrow({ where: { number }, select: { amountPaid: true } });
    expect(row.amountPaid.toFixed(2)).toBe("912.00");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).balance.toFixed(2)).toBe("0.00");
    const history = await prisma.invoiceEvent.findMany({ where: { invoice: { number } }, select: { type: true } });
    expect(history.map((e) => e.type)).toEqual(expect.arrayContaining(["creditNote", "creditNoteDeleted"]));
  });
});
