import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
async function ok<T = any>(res: { status: number; body: any }, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const chair = { name: "كرسي مكتب", type: "product", code: "PRD-001", price: "200", taxRate: "14", category: "devices", stock: "10", lowStockAt: "2", cost: "100" };

async function setup(token: string, product: Record<string, unknown> = chair) {
  const p = (await ok(await api().post("/api/products").set(auth(token)).send(product), 201)).product;
  const c = (await ok(await api().post("/api/customers").set(auth(token)).send({ name: "شركة النيل" }), 201)).customer;
  return { productId: p.id as string, customerId: c.id as string };
}
const product = async (token: string, id: string) => (await ok(await api().get(`/api/products/${id}`).set(auth(token)))).product;
const receive = (token: string, id: string, body: Record<string, unknown>) =>
  api().post(`/api/products/${id}/stock`).set(auth(token)).send({ kind: "received", ...body });
const sell = async (token: string, customerId: string, productId: string, quantity: string) =>
  (
    await ok(
      await api()
        .post("/api/invoices")
        .set(auth(token))
        .send({ customerId, issueDate: today(), terms: 30, send: true, items: [{ description: "كرسي", quantity, unitPrice: "200", productId }] }),
      201,
    )
  ).invoice;
const stockEntries = async (token: string) =>
  (await ok(await api().get("/api/ledger/entries?source=stock&pageSize=100").set(auth(token)))).items as {
    source: string;
    memo: string;
    ref: string | null;
    amount: string;
    lines: { key: string | null; debit: string; credit: string }[];
  }[];
const linesOf = (e: { lines: { key: string | null; debit: string; credit: string }[] }) => e.lines.map((l) => `${l.key} ${l.debit}/${l.credit}`);
async function books(token: string) {
  const trial = await ok(await api().get("/api/ledger/trial-balance").set(auth(token)));
  const sheet = (await ok(await api().get("/api/reports/balance-sheet").set(auth(token)))).balanceSheet;
  const inventory = sheet.assets.rows.find((r: { account: { key: string } }) => r.account.key === "inventory")?.amount ?? "0.00";
  return { balanced: trial.balanced as boolean, inventory: inventory as string, sheet };
}

describe("inventory cost (weighted average)", () => {
  it("opening stock at cost; a purchase moves the average; sales leave at it into the cost of goods sold", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    expect(await product(token, productId)).toMatchObject({ stock: 10, cost: "100" });
    // Opening: Dr inventory / Cr capital.
    expect((await stockEntries(token)).map(linesOf)).toEqual([["inventory 1000.00/0.00", "capital 0.00/1000.00"]]);

    // 10 more at 130 (+14% VAT), paid from the cash box: a purchase that is inventory.
    await ok(await receive(token, productId, { quantity: "10", unitCost: "130", paidFrom: "cash", vendor: "مورد الأثاث", vat: "182" }));
    expect(await product(token, productId)).toMatchObject({ stock: 20, cost: "115" });
    const expenses = (await ok(await api().get("/api/expenses").set(auth(token)))).items;
    expect(expenses[0]).toMatchObject({ category: "purchases", amount: "1482.00", vat: "182.00", vendor: "مورد الأثاث", status: "paid", stock: { productId, quantity: "10" } });
    const purchase = (await ok(await api().get("/api/ledger/entries?source=expense").set(auth(token)))).items[0];
    expect(linesOf(purchase)).toEqual(["inventory 1300.00/0.00", "vatInput 182.00/0.00", "cashbox 0.00/1482.00"]);

    // Sell 4: they leave at 115 each.
    const inv = await sell(token, customerId, productId, "4");
    const [sold] = await stockEntries(token);
    expect(sold).toMatchObject({ source: "stockSold", memo: "كرسي مكتب", ref: inv.displayNumber, amount: "460.00" });
    expect(linesOf(sold!)).toEqual(["cogs 460.00/0.00", "inventory 0.00/460.00"]);
    expect(await product(token, productId)).toMatchObject({ stock: 16, cost: "115" });

    // The books: balanced; inventory = 1000 + 1300 - 460.
    expect(await books(token)).toMatchObject({ balanced: true, inventory: "1840.00" });
    // The movement log shows each one's cost.
    const log = (await ok(await api().get(`/api/products/${productId}/movements`).set(auth(token)))).items;
    expect(log.map((m: { kind: string; unitCost: string; value: string }) => [m.kind, m.unitCost, m.value])).toEqual([
      ["sale", "115", "-460.00"],
      ["received", "130", "1300.00"],
      ["opening", "100", "1000.00"],
    ]);
    expect(log[1].purchase).toMatchObject({ vendor: "مورد الأثاث", due: false });
  });

  it("a cancelled sale and a return come back at what they went out at; the profit counts the cost of what was sold", async () => {
    const { token } = await ownerSession();
    const { productId, customerId } = await setup(token);
    const first = await sell(token, customerId, productId, "4");
    await ok(await api().post(`/api/invoices/${first.number}/cancel`).set(auth(token)));
    // A dearer purchase after the sale: the average changes, but the cancellation came back at 100.
    await ok(await receive(token, productId, { quantity: "10", unitCost: "160", paidFrom: "bank" }));
    expect(await product(token, productId)).toMatchObject({ stock: 20, cost: "130" });

    const second = await sell(token, customerId, productId, "5");
    await ok(
      await api()
        .post(`/api/invoices/${second.number}/credit-notes`)
        .set(auth(token))
        .send({ date: today(), reason: "return", lines: [{ description: "كرسي", quantity: "2", unitPrice: "200", productId }] }),
      201,
    );
    const entries = await stockEntries(token);
    expect(entries.map((e) => [e.source, e.amount])).toEqual([
      ["stockSold", "260.00"], // the return, at the sale's 130
      ["stockSold", "650.00"], // 5 × 130
      ["stockSold", "400.00"], // the cancelled sale back at 100
      ["stockSold", "400.00"], // 4 × 100
      ["stockValue", "1000.00"],
    ]);
    expect(linesOf(entries[0]!)).toEqual(["inventory 260.00/0.00", "cogs 0.00/260.00"]);

    // Profit: revenue (5 - 2 returned) × 200 = 600; cost of goods 650 - 260 = 390; the purchase isn't a cost.
    const summary = (await ok(await api().get("/api/reports/summary").set(auth(token)))).summary;
    expect(summary).toMatchObject({ revenue: "600.00", cost: "390.00", grossProfit: "210.00" });
    expect(summary.lines).toEqual(expect.arrayContaining([{ key: "costOfGoods", kind: "cost", amount: "390.00" }, { key: "purchases", kind: "cost", amount: "0.00" }]));
    const dash = (await ok(await api().get("/api/dashboard").set(auth(token)))).financials;
    expect(dash).toMatchObject({ revenue: "600.00", expenses: "390.00", netProfit: "210.00" });
    expect(await books(token)).toMatchObject({ balanced: true, inventory: "2210.00" }); // 17 × 130
  });

  it("damage and counts are stock losses at the average; a new cost values what's on hand again", async () => {
    const { token } = await ownerSession();
    const { productId } = await setup(token);
    await ok(await api().post(`/api/products/${productId}/stock`).set(auth(token)).send({ kind: "damaged", quantity: "1" }));
    await ok(await api().post(`/api/products/${productId}/stock`).set(auth(token)).send({ kind: "counted", quantity: "10" })); // found one more
    const [found, damaged] = await stockEntries(token);
    expect(linesOf(damaged!)).toEqual(["stockLoss 100.00/0.00", "inventory 0.00/100.00"]);
    expect(linesOf(found!)).toEqual(["inventory 100.00/0.00", "stockLoss 0.00/100.00"]);

    // 120 from now on: the 10 on hand are worth 1200 (+200 against capital).
    await ok(await api().patch(`/api/products/${productId}`).set(auth(token)).send({ cost: "120" }));
    const [costed] = await stockEntries(token);
    expect(costed).toMatchObject({ source: "stockValue", amount: "200.00" });
    expect(await books(token)).toMatchObject({ balanced: true, inventory: "1200.00" });
    expect((await product(token, productId)).cost).toBe("120");
  });

  it("goods with no cost yet: valued when a cost is first set; received with no cost moves no value", async () => {
    const { token } = await ownerSession();
    const { productId } = await setup(token, { ...chair, cost: undefined });
    expect((await product(token, productId)).cost).toBeNull();
    await ok(await receive(token, productId, { quantity: "5" }));
    expect(await stockEntries(token)).toEqual([]);
    await ok(await api().patch(`/api/products/${productId}`).set(auth(token)).send({ cost: "50" }));
    expect(await books(token)).toMatchObject({ balanced: true, inventory: "750.00" }); // 15 × 50
  });

  it("a purchase owed to the supplier; deleting a purchase undoes its receipt", async () => {
    const { token } = await ownerSession();
    const { productId } = await setup(token);
    await ok(await receive(token, productId, { quantity: "10", unitCost: "130", paidFrom: "due", vendor: "مورد الأثاث", dueDate: today() }));
    const [purchase] = (await ok(await api().get("/api/expenses").set(auth(token)))).items;
    expect(purchase).toMatchObject({ status: "due", amount: "1300.00" });
    const entry = (await ok(await api().get("/api/ledger/entries?source=expense").set(auth(token)))).items[0];
    expect(linesOf(entry)).toEqual(["inventory 1300.00/0.00", "suppliers 0.00/1300.00"]);
    expect((await ok(await api().get("/api/suppliers").set(auth(token)))).items[0]).toMatchObject({ name: "مورد الأثاث", due: "1300.00" });

    await ok(await api().delete(`/api/expenses/${purchase.id}`).set(auth(token)), 204);
    expect(await product(token, productId)).toMatchObject({ stock: 10, cost: "100" });
    const log = (await ok(await api().get(`/api/products/${productId}/movements`).set(auth(token)))).items;
    expect(log[0]).toMatchObject({ kind: "receiptRemoved", quantity: "-10.000", value: "-1300.00" });
    expect(await books(token)).toMatchObject({ balanced: true, inventory: "1000.00" });

    // A cost needs how it was paid; only goods received have a purchase cost.
    expect((await receive(token, productId, { quantity: "1", unitCost: "10" })).status).toBe(400);
    expect((await api().post(`/api/products/${productId}/stock`).set(auth(token)).send({ kind: "damaged", quantity: "1", unitCost: "10", paidFrom: "cash" })).status).toBe(400);
  });
});
