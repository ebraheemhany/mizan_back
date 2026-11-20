import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function setup() {
  const owner = await ownerSession();
  const customer = (
    await api().post("/api/customers").set(auth(owner.token)).send({ name: "شركة النيل", phone: "01000000000" })
  ).body.customer;
  const invoice = async (unitPrice = "1000", issueDate = today(), terms = 30, send = true) =>
    (
      await api()
        .post("/api/invoices")
        .set(auth(owner.token))
        .send({ customerId: customer.id, issueDate, terms, send, items: [{ description: "x", quantity: "1", unitPrice }] })
    ).body.invoice;
  return { owner, customer, invoice };
}

const pay = (token: string, body: Record<string, unknown>) =>
  api().post("/api/payments").set(auth(token)).send({ date: today(), method: "bank", ...body });

const balanceOf = async (customerId: string) =>
  (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).balance.toFixed(2);

describe("recording payments from the payments page", () => {
  it("numbers receipts PAY-0001, PAY-0002... and keeps the extra details", async () => {
    const { owner, invoice } = await setup();
    const inv = await invoice(); // 1140.00

    const first = await pay(owner.token, {
      invoiceId: inv.id,
      amount: "140",
      method: "instapay",
      account: "wallet",
      reference: "TX-998",
      note: "دفعة أولى",
    });
    expect(first.status).toBe(201);
    expect(first.body.payment).toMatchObject({
      number: "PAY-0001",
      invoiceNumber: inv.number,
      invoiceDisplayNumber: "INV-1",
      customer: "شركة النيل",
      amount: "140.00",
      method: "instapay",
      status: "cleared",
      account: "wallet",
      reference: "TX-998",
    });

    const second = await pay(owner.token, { invoiceId: inv.id, amount: "1000" });
    expect(second.body.payment.number).toBe("PAY-0002");
    const detail = await api().get(`/api/invoices/${inv.number}`).set(auth(owner.token));
    expect(detail.body.invoice).toMatchObject({ status: "paid", remaining: "0.00" });
    expect(detail.body.invoice.history[0]).toMatchObject({ type: "payment", values: { payment: "PAY-0002" } });
  });

  it("invoice and payments page share the same receipt numbers, without repeats", async () => {
    const { owner, invoice } = await setup();
    const inv = await invoice("10000");
    const results = await Promise.all([
      pay(owner.token, { invoiceId: inv.id, amount: "100" }),
      api().post(`/api/invoices/${inv.number}/payments`).set(auth(owner.token)).send({ amount: "100", date: today(), method: "cash" }),
      pay(owner.token, { invoiceId: inv.id, amount: "100" }),
    ]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = (await prisma.invoicePayment.findMany({ select: { number: true } })).map((p) => p.number).sort();
    expect(numbers).toEqual([1, 2, 3]);
  });

  it("a cheque lowers what is owed at once, but only counts as collected once it clears", async () => {
    const { owner, customer, invoice } = await setup();
    const inv = await invoice(); // 1140.00

    const cheque = await pay(owner.token, { invoiceId: inv.id, amount: "500", method: "cheque", reference: "CHQ-1" });
    expect(cheque.body.payment.status).toBe("pending");
    expect(await balanceOf(customer.id)).toBe("640.00");

    let stats = (await api().get("/api/payments/stats").set(auth(owner.token))).body.stats;
    expect(stats).toMatchObject({ collectedThisMonth: "0.00", pendingCheques: "500.00", pendingChequesCount: 1 });

    const cleared = await api().post(`/api/payments/${cheque.body.payment.id}/clear`).set(auth(owner.token));
    expect(cleared.body.payment.status).toBe("cleared");
    stats = (await api().get("/api/payments/stats").set(auth(owner.token))).body.stats;
    expect(stats).toMatchObject({ collectedThisMonth: "500.00", pendingCheques: "0.00", pendingChequesCount: 0 });

    const again = await api().post(`/api/payments/${cheque.body.payment.id}/clear`).set(auth(owner.token));
    expect(again.status).toBe(409);
  });

  it("removing a payment puts the amount back on the invoice and the customer", async () => {
    const { owner, customer, invoice } = await setup();
    const inv = await invoice(); // 1140.00
    const full = (await pay(owner.token, { invoiceId: inv.id, amount: "1140" })).body.payment;
    expect(await balanceOf(customer.id)).toBe("0.00");

    const res = await api().delete(`/api/payments/${full.id}`).set(auth(owner.token));
    expect(res.status).toBe(204);

    const detail = (await api().get(`/api/invoices/${inv.number}`).set(auth(owner.token))).body.invoice;
    expect(detail).toMatchObject({ status: "sent", remaining: "1140.00" });
    expect(detail.payments).toHaveLength(0);
    expect(detail.history[0]).toMatchObject({ type: "paymentRemoved", values: { payment: "PAY-0001" } });
    expect(await balanceOf(customer.id)).toBe("1140.00");

    expect((await api().delete(`/api/payments/${full.id}`).set(auth(owner.token))).status).toBe(404);
  });

  it("removing one of two payments leaves the invoice partly paid", async () => {
    const { owner, invoice } = await setup();
    const inv = await invoice();
    await pay(owner.token, { invoiceId: inv.id, amount: "140" });
    const second = (await pay(owner.token, { invoiceId: inv.id, amount: "1000" })).body.payment;

    await api().delete(`/api/payments/${second.id}`).set(auth(owner.token));
    const detail = (await api().get(`/api/invoices/${inv.number}`).set(auth(owner.token))).body.invoice;
    expect(detail).toMatchObject({ status: "partial", remaining: "1000.00" });
  });

  it("validates like a payment on the invoice page", async () => {
    const { owner, invoice } = await setup();
    const inv = await invoice();
    expect((await pay(owner.token, { invoiceId: inv.id, amount: "2000" })).body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect((await pay(owner.token, { invoiceId: inv.id, amount: "10", method: "bitcoin" })).status).toBe(400);
    expect((await pay(owner.token, { invoiceId: inv.id, amount: "10", account: "safe" })).status).toBe(400);
    expect((await pay(owner.token, { amount: "10" })).status).toBe(400);
  });
});

describe("payments list, stats, open invoices", () => {
  it("lists newest first, searches by receipt, invoice or customer, and filters by method", async () => {
    const { owner, invoice } = await setup();
    // Issued 5 days ago, so payments can be dated in the last few days.
    const a = await invoice("5000", addDays(today(), -5));
    const b = await invoice("5000", addDays(today(), -5));
    await pay(owner.token, { invoiceId: a.id, amount: "10", method: "cash", date: addDays(today(), -2) });
    await pay(owner.token, { invoiceId: b.id, amount: "20", method: "bank" });
    await pay(owner.token, { invoiceId: a.id, amount: "30", method: "cheque", date: addDays(today(), -1) });

    const numbers = async (query = "") =>
      (await api().get(`/api/payments${query}`).set(auth(owner.token))).body.items.map((p: { number: string }) => p.number);

    expect(await numbers()).toEqual(["PAY-0002", "PAY-0003", "PAY-0001"]);
    expect(await numbers("?q=PAY-0003")).toEqual(["PAY-0003"]);
    expect(await numbers("?q=%232")).toEqual(["PAY-0002"]); // "#2" = invoice 2 (also receipt 2)
    expect(await numbers("?method=cash")).toEqual(["PAY-0001"]);
    expect(await numbers("?q=النيل&pageSize=2")).toHaveLength(2);
    expect((await api().get("/api/payments?pageSize=2").set(auth(owner.token))).body).toMatchObject({ total: 3, all: 3 });
    expect((await api().get("/api/payments/export?pageSize=1").set(auth(owner.token))).body.items).toHaveLength(3);
  });

  it("open invoices show what is left, soonest due first, with days overdue", async () => {
    const { owner, invoice } = await setup();
    const late = await invoice("1000", addDays(today(), -20), 15); // due 5 days ago
    const soon = await invoice("2000");
    await invoice("3000", today(), 30, false); // draft: not open
    await pay(owner.token, { invoiceId: soon.id, amount: "280" });

    const list = (await api().get("/api/payments/open-invoices").set(auth(owner.token))).body.invoices;
    expect(list.map((i: { number: number }) => i.number)).toEqual([late.number, soon.number]);
    expect(list[0]).toMatchObject({ balance: "1140.00", daysOverdue: 5, customerPhone: "01000000000" });
    expect(list[1]).toMatchObject({ balance: "2000.00", daysOverdue: null });

    const stats = (await api().get("/api/payments/stats").set(auth(owner.token))).body.stats;
    expect(stats).toMatchObject({ awaiting: "3140.00", awaitingCount: 2, avgDaysToCollect: 0 });
  });

  it("open invoices name the customer as they are now (renamed after the invoice)", async () => {
    const { owner, customer, invoice } = await setup();
    const inv = await invoice();
    const renamed = await api()
      .patch(`/api/customers/${customer.id}`)
      .set(auth(owner.token))
      .send({ name: "النيل للتجارة", phone: "01111111111" });
    expect(renamed.status).toBe(200);

    const [row] = (await api().get("/api/payments/open-invoices").set(auth(owner.token))).body.invoices;
    expect(row).toMatchObject({ customer: "النيل للتجارة", customerPhone: "01111111111" });
    // The invoice itself keeps the name it was issued with.
    expect((await api().get(`/api/invoices/${inv.number}`).set(auth(owner.token))).body.invoice.client.name).toBe(
      "شركة النيل",
    );
  });
});

describe("permissions and isolation", () => {
  it("everyone views; owner and accountant record, clear and remove", async () => {
    const { owner, invoice } = await setup();
    const inv = await invoice();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");

    expect((await api().get("/api/payments").set(auth(sales.token))).status).toBe(200);
    expect((await pay(sales.token, { invoiceId: inv.id, amount: "10" })).status).toBe(403);
    const byAccountant = await pay(accountant.token, { invoiceId: inv.id, amount: "10", method: "cheque" });
    expect(byAccountant.status).toBe(201);
    const id = byAccountant.body.payment.id;
    expect((await api().post(`/api/payments/${id}/clear`).set(auth(sales.token))).status).toBe(403);
    expect((await api().delete(`/api/payments/${id}`).set(auth(sales.token))).status).toBe(403);
  });

  it("another company's payments and invoices are out of reach", async () => {
    const mine = await setup();
    const theirs = await setup();
    const theirInvoice = await theirs.invoice();
    const theirPayment = (await pay(theirs.owner.token, { invoiceId: theirInvoice.id, amount: "100" })).body.payment;

    expect((await api().get("/api/payments").set(auth(mine.owner.token))).body.total).toBe(0);
    expect((await pay(mine.owner.token, { invoiceId: theirInvoice.id, amount: "1" })).status).toBe(404);
    expect((await api().post(`/api/payments/${theirPayment.id}/clear`).set(auth(mine.owner.token))).status).toBe(404);
    expect((await api().delete(`/api/payments/${theirPayment.id}`).set(auth(mine.owner.token))).status).toBe(404);
    expect((await api().get("/api/payments/open-invoices").set(auth(mine.owner.token))).body.invoices).toHaveLength(0);
  });
});

describe("GET /api/dashboard", () => {
  it("revenue is what was invoiced this month before VAT; drafts and cancelled don't count", async () => {
    const { owner, invoice } = await setup();
    await invoice("1000"); // subtotal 1000
    await invoice("500", addDays(today(), -40), 30); // overdue, maybe last month
    await invoice("9999", today(), 30, false); // draft
    const cancelled = await invoice("7777");
    await api().post(`/api/invoices/${cancelled.id}/cancel`).set(auth(owner.token));

    const res = await api().get("/api/dashboard").set(auth(owner.token));
    expect(res.status).toBe(200);
    const { financials, receivable, attention, invoicesThisMonth } = res.body;

    expect(financials.chart).toHaveLength(6);
    expect(financials.chart[5].month).toBe(today().slice(0, 7));
    const chartTotal = financials.chart.reduce((sum: number, m: { revenue: string }) => sum + Number(m.revenue), 0);
    expect(chartTotal).toBe(1500);
    expect(Number(financials.revenue)).toBe(financials.chart[5].revenue === "1500.00" ? 1500 : 1000);
    expect(financials).toMatchObject({ expenses: "0.00" });
    expect(receivable).toEqual({ outstanding: "1710.00", overdue: "570.00" });
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ type: "invoiceOverdue", amount: "570.00", days: 10 });
    expect(invoicesThisMonth).toBeGreaterThanOrEqual(3);
  });

  it("revenue figures are only for roles that may see reports", async () => {
    const { owner, invoice } = await setup();
    await invoice();
    const sales = await teamMember(owner.token, "sales");
    const accountant = await teamMember(owner.token, "accountant");

    const forSales = (await api().get("/api/dashboard").set(auth(sales.token))).body;
    expect(forSales.financials).toBeNull();
    expect(forSales.receivable.outstanding).toBe("1140.00");
    expect((await api().get("/api/dashboard").set(auth(accountant.token))).body.financials).not.toBeNull();
  });
});
