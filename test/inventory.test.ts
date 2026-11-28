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

const chair = { name: "كرسي مكتب", type: "product", code: "PRD-001", price: "200", taxRate: "14", category: "devices", stock: "10", lowStockAt: "3" };

async function setup(token: string) {
  const product = (await ok(await api().post("/api/products").set(auth(token)).send(chair), 201)).product;
  const customer = (await ok(await api().post("/api/customers").set(auth(token)).send({ name: "شركة النيل" }), 201)).customer;
  return { productId: product.id as string, customerId: customer.id as string };
}

const invoice = (token: string, customerId: string, items: Record<string, unknown>[], send = true) =>
  api().post("/api/invoices").set(auth(token)).send({ customerId, issueDate: today(), terms: 30, send, items });
const stockOf = async (token: string, id: string) => (await ok(await api().get(`/api/products/${id}`).set(auth(token)))).product.stock;
const movements = async (token: string, id: string) =>
  (await ok(await api().get(`/api/products/${id}/movements`).set(auth(token)))).items as {
    kind: string;
    quantity: string;
    balance: string;
    invoice: { displayNumber: string } | null;
    creditNote: string | null;
    by: string | null;
  }[];
const adjust = (token: string, id: string, body: Record<string, unknown>) => api().post(`/api/products/${id}/stock`).set(auth(token)).send(body);

describe("inventory", () => {
  it("a new product's stock opens its log; an issued invoice takes it out, a cancelled one puts it back", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    expect(await stockOf(token, productId)).toBe(10);
    expect((await movements(token, productId)).map((m) => [m.kind, m.quantity, m.balance])).toEqual([["opening", "10.000", "10.000"]]);

    // Two lines of the chair and a free-text line: 3 + 1 go out, in one movement.
    const sold = (
      await ok(
        await invoice(token, customerId, [
          { description: "كرسي مكتب", quantity: "3", unitPrice: "200", productId },
          { description: "تركيب", quantity: "1", unitPrice: "50" },
          { description: "كرسي مكتب (هدية)", quantity: "1", unitPrice: "0", productId },
        ]),
        201,
      )
    ).invoice;
    expect(await stockOf(token, productId)).toBe(6);
    const [sale] = await movements(token, productId);
    expect(sale).toMatchObject({ kind: "sale", quantity: "-4.000", balance: "6.000", invoice: { displayNumber: sold.displayNumber } });
    expect(sale?.by).toBeTruthy();

    await ok(await api().post(`/api/invoices/${sold.number}/cancel`).set(auth(token)));
    expect(await stockOf(token, productId)).toBe(10);
    expect((await movements(token, productId))[0]).toMatchObject({ kind: "saleCancelled", quantity: "4.000", balance: "10.000" });
  });

  it("a draft moves nothing until it is issued", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    const draft = (await ok(await invoice(token, customerId, [{ description: "كرسي", quantity: "2", unitPrice: "200", productId }], false), 201)).invoice;
    expect(await stockOf(token, productId)).toBe(10);
    await ok(await api().post(`/api/invoices/${draft.number}/send`).set(auth(token)));
    expect(await stockOf(token, productId)).toBe(8);
    // Cancelling a draft never touched stock.
    const other = (await ok(await invoice(token, customerId, [{ description: "كرسي", quantity: "5", unitPrice: "200", productId }], false), 201)).invoice;
    await ok(await api().post(`/api/invoices/${other.number}/cancel`).set(auth(token)));
    expect(await stockOf(token, productId)).toBe(8);
  });

  it("selling more than is on hand is allowed (the stock goes below zero); decimals work", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    await ok(await invoice(token, customerId, [{ description: "كرسي", quantity: "12.5", unitPrice: "200", productId }]), 201);
    expect(await stockOf(token, productId)).toBe(-2.5);
  });

  it("a return puts the items back, never more than sold less earlier returns; deleting it takes them out again", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    const sold = (await ok(await invoice(token, customerId, [{ description: "كرسي", quantity: "4", unitPrice: "200", productId }]), 201)).invoice;
    const credit = (body: Record<string, unknown>) =>
      api()
        .post(`/api/invoices/${sold.number}/credit-notes`)
        .set(auth(token))
        .send({ date: today(), reason: "return", ...body });

    const after = (await ok(await credit({ lines: [{ description: "كرسي", quantity: "3", unitPrice: "200", productId }] }), 201)).invoice;
    expect(await stockOf(token, productId)).toBe(9);
    expect(after.creditNotes[0].lines[0].productId).toBe(productId);
    expect((await movements(token, productId))[0]).toMatchObject({ kind: "returned", quantity: "3.000", creditNote: "CN-0001" });

    const over = await credit({ lines: [{ description: "كرسي", quantity: "2", unitPrice: "200", productId }] });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: "RETURN_EXCEEDS_SOLD", details: { returnable: "1.000" } });

    // A product that isn't on this invoice can't be "returned".
    const other = (await ok(await api().post("/api/products").set(auth(token)).send({ ...chair, code: "PRD-002", name: "مكتب" }), 201)).product;
    expect((await credit({ lines: [{ description: "مكتب", quantity: "1", unitPrice: "100", productId: other.id }] })).body.error.code).toBe("INVALID_PRODUCT");

    // A discount names no item and moves no stock.
    await ok(await credit({ reason: "discount", lines: [{ description: "خصم", quantity: "1", unitPrice: "50", productId }] }), 201);
    expect(await stockOf(token, productId)).toBe(9);

    await ok(await api().delete(`/api/invoices/${sold.number}/credit-notes/${after.creditNotes[0].id}`).set(auth(token)));
    expect(await stockOf(token, productId)).toBe(6);
    expect((await movements(token, productId))[0]).toMatchObject({ kind: "returnRemoved", quantity: "-3.000", balance: "6.000" });
  });

  it("by hand: goods received, damage and a count; services have none; dates not ahead", async () => {
    const { token } = await ownerSession();
    const { productId } = await setup(token);
    expect((await ok(await adjust(token, productId, { kind: "received", quantity: "5", note: "من المورد" }))).product.stock).toBe(15);
    expect((await ok(await adjust(token, productId, { kind: "damaged", quantity: "1.5" }))).product.stock).toBe(13.5);
    // A count says what's on hand; the difference is logged.
    expect((await ok(await adjust(token, productId, { kind: "counted", quantity: "12" }))).product.stock).toBe(12);
    // A count that matches moves nothing but is logged.
    await ok(await adjust(token, productId, { kind: "counted", quantity: "12" }));
    expect((await movements(token, productId)).map((m) => [m.kind, m.quantity, m.balance])).toEqual([
      ["counted", "0.000", "12.000"],
      ["counted", "-1.500", "12.000"],
      ["damaged", "-1.500", "13.500"],
      ["received", "5.000", "15.000"],
      ["opening", "10.000", "10.000"],
    ]);

    expect((await adjust(token, productId, { kind: "received", quantity: "0" })).status).toBe(400);
    expect((await adjust(token, productId, { kind: "received", quantity: "1", date: addDays(today(), 1) })).body.error.code).toBe(
      "STOCK_DATE_IN_FUTURE",
    );
    const service = (
      await ok(
        await api().post("/api/products").set(auth(token)).send({ name: "تركيب", type: "service", code: "SRV-001", price: "50", taxRate: "14", category: "support" }),
        201,
      )
    ).product;
    expect((await adjust(token, service.id, { kind: "received", quantity: "1" })).body.error.code).toBe("NOT_STOCKED");

    // Sales people see the log but can't change the stock.
    const sales = await teamMember(token, "sales");
    expect((await api().get(`/api/products/${productId}/movements`).set(auth(sales.token))).status).toBe(200);
    expect((await adjust(sales.token, productId, { kind: "received", quantity: "1" })).status).toBe(403);
    const log = await api().get("/api/audit").set(auth(token));
    expect(JSON.stringify(log.body)).toContain("stockAdjusted");
  });

  it("editing the stock in the form logs a count; the low-stock list and the dashboard", async () => {
    const { token } = await ownerSession();
    const { productId } = await setup(token);
    await ok(await api().patch(`/api/products/${productId}`).set(auth(token)).send({ stock: "2" }));
    expect((await movements(token, productId))[0]).toMatchObject({ kind: "counted", quantity: "-8.000", balance: "2.000" });

    // 2 is under the alert level of 3; another product with plenty isn't.
    await ok(await api().post("/api/products").set(auth(token)).send({ ...chair, code: "PRD-002", name: "مكتب", stock: "50" }), 201);
    const low = await ok(await api().get("/api/products?stock=low").set(auth(token)));
    expect(low.items.map((p: { id: string }) => p.id)).toEqual([productId]);
    expect(low.counts.low).toBe(1);
    const dash = await ok(await api().get("/api/dashboard").set(auth(token)));
    expect(dash.lowStock).toEqual({ count: 1, items: [{ id: productId, name: "كرسي مكتب", code: "PRD-001", stock: 2, lowStockAt: 3 }] });
  });

  it("an import opens each product's stock", async () => {
    const { token } = await ownerSession();
    const res = await ok(
      await api()
        .post("/api/products/import")
        .set(auth(token))
        .send({ products: [chair, { ...chair, code: "PRD-002", name: "مكتب", stock: "0" }] }),
      201,
    );
    expect(res.created).toBe(2);
    const rows = await prisma.product.findMany({ orderBy: { code: "asc" }, select: { id: true, stock: true } });
    expect(rows.map((r) => Number(r.stock))).toEqual([10, 0]);
    expect(await prisma.stockMovement.count({ where: { productId: rows[0]!.id, kind: "opening" } })).toBe(1);
    expect(await prisma.stockMovement.count({ where: { productId: rows[1]!.id } })).toBe(0);
  });
});
