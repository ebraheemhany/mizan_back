import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, businessToday, monthRange } from "../src/lib/dates.js";
import { UNDO_WINDOW_MS } from "../src/modules/expenses/expenses.service.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());
afterAll(() => {
  vi.useRealTimers();
});

const today = () => businessToday();
const lastMonthDay = () => monthRange(today(), -1).start;

const add = (token: string, body: Record<string, unknown>) =>
  api()
    .post("/api/expenses")
    .set(auth(token))
    .send({ title: "فاتورة إنترنت", category: "utilities", amount: "1240", date: today(), ...body });

describe("POST /api/expenses", () => {
  it("adds a paid expense with exact money and where it was paid from", async () => {
    const owner = await ownerSession();
    const res = await add(owner.token, { amount: "999999999999.99", paidFrom: "bank", vendor: "  WE  " });
    expect(res.status).toBe(201);
    expect(res.body.expense).toMatchObject({
      title: "فاتورة إنترنت",
      category: "utilities",
      amount: "999999999999.99",
      date: today(),
      status: "paid",
      paidFrom: "bank",
      dueDate: null,
      vendor: "WE",
    });
  });

  it("adds a due expense owed to a vendor", async () => {
    const owner = await ownerSession();
    const res = await add(owner.token, {
      title: "أجهزة",
      category: "purchases",
      amount: "6200",
      status: "due",
      dueDate: addDays(today(), 10),
      vendor: "مورد الأجهزة",
    });
    expect(res.body.expense).toMatchObject({ status: "due", paidFrom: null, dueDate: addDays(today(), 10) });
  });

  it("validates the input", async () => {
    const owner = await ownerSession();
    const bad: Record<string, unknown>[] = [
      { title: "" },
      { amount: "0" },
      { amount: "-5" },
      { amount: "1.005" },
      { category: "travel" },
      { date: "2026-02-30" },
      { status: "due", paidFrom: "cash" },
      { status: "paid", dueDate: today() },
      { status: "due", dueDate: addDays(today(), -1) },
      { paidFrom: "wallet" },
    ];
    for (const body of bad) {
      expect((await add(owner.token, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.expense.count()).toBe(0);
  });
});

describe("paying a due expense", () => {
  it("marks it paid once", async () => {
    const owner = await ownerSession();
    const due = (await add(owner.token, { status: "due", vendor: "X" })).body.expense;
    const res = await api().post(`/api/expenses/${due.id}/pay`).set(auth(owner.token)).send({ paidFrom: "cash" });
    expect(res.body.expense).toMatchObject({ status: "paid", paidFrom: "cash" });
    const again = await api().post(`/api/expenses/${due.id}/pay`).set(auth(owner.token)).send({ paidFrom: "cash" });
    expect(again.status).toBe(409);
  });
});

describe("list and stats", () => {
  it("lists newest first, with search, category, status and period filters", async () => {
    const owner = await ownerSession();
    await add(owner.token, { title: "إيجار المكتب", category: "rent", amount: "8500", date: lastMonthDay() });
    await add(owner.token, { title: "رواتب", category: "salaries", amount: "24000" });
    await add(owner.token, { title: "أجهزة", category: "purchases", amount: "6200", status: "due", vendor: "مورد الأجهزة" });

    const titles = async (query = "") =>
      (await api().get(`/api/expenses${query}`).set(auth(owner.token))).body.items.map((e: { title: string }) => e.title);

    expect((await titles()).at(-1)).toBe("إيجار المكتب");
    expect(await titles("?category=rent")).toEqual(["إيجار المكتب"]);
    expect(await titles("?status=due")).toEqual(["أجهزة"]);
    expect(await titles("?q=مورد")).toEqual(["أجهزة"]);
    expect((await titles("?period=thisMonth")).sort()).toEqual(["أجهزة", "رواتب"].sort());
    expect(await titles("?period=lastMonth")).toEqual(["إيجار المكتب"]);
    expect((await api().get("/api/expenses/export?pageSize=1").set(auth(owner.token))).body.items).toHaveLength(3);
  });

  it("stats: month total vs last month, top categories, what is owed, and net profit", async () => {
    const owner = await ownerSession();
    await add(owner.token, { category: "rent", amount: "1000", date: lastMonthDay() });
    await add(owner.token, { category: "salaries", amount: "3000" });
    await add(owner.token, { category: "utilities", amount: "1000" });
    await add(owner.token, { category: "purchases", amount: "500", status: "due", vendor: "A" });
    await add(owner.token, { category: "purchases", amount: "300", status: "due", vendor: "A" });
    await add(owner.token, { category: "purchases", amount: "200", status: "due" }); // no vendor: counts on its own

    // Revenue this month: one invoice of 10000 before VAT.
    const customer = (await api().post("/api/customers").set(auth(owner.token)).send({ name: "C" })).body.customer;
    await api()
      .post("/api/invoices")
      .set(auth(owner.token))
      .send({ customerId: customer.id, issueDate: today(), terms: 30, send: true, items: [{ description: "x", quantity: "1", unitPrice: "10000" }] });

    const { stats } = (await api().get("/api/expenses/stats").set(auth(owner.token))).body;
    expect(stats).toMatchObject({
      month: today().slice(0, 7),
      total: "5000.00", // due expenses count in their month too
      prevTotal: "1000.00",
      changePct: 400,
      due: "1000.00",
      dueCount: 3,
      dueVendors: 2,
      revenue: "10000.00",
      netProfit: "5000.00",
    });
    expect(stats.byCategory[0]).toEqual({ category: "salaries", amount: "3000.00", share: 60 });
    expect(stats.byCategory.map((c: { category: string }) => c.category)).toEqual(["salaries", "purchases", "utilities"]);

    const due = (await api().get("/api/expenses/due").set(auth(owner.token))).body.items;
    expect(due).toHaveLength(3);
  });
});

describe("dashboard uses real expenses", () => {
  it("expenses, net profit and their change vs last month", async () => {
    const owner = await ownerSession();
    await add(owner.token, { amount: "2000", date: lastMonthDay() });
    await add(owner.token, { amount: "1000" });

    const { financials } = (await api().get("/api/dashboard").set(auth(owner.token))).body;
    expect(financials).toMatchObject({ expenses: "1000.00", expensesChange: -50, netProfit: "-1000.00" });
    // Last month's profit was -2000, this month's -1000: an improvement of 50%.
    expect(financials.netProfitChange).toBe(50);
    expect(financials.chart.at(-1).expenses).toBe("1000.00");
    expect(financials.chart.at(-2).expenses).toBe("2000.00");
  });
});

describe("permissions", () => {
  it("only owner and accountant can see or add expenses", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    expect((await add(accountant.token, {})).status).toBe(201);
    for (const { token } of [sales, viewer]) {
      expect((await api().get("/api/expenses").set(auth(token))).status).toBe(403);
      expect((await api().get("/api/expenses/stats").set(auth(token))).status).toBe(403);
      expect((await add(token, {})).status).toBe(403);
    }
  });

  it("deleting: the creator within the undo window, otherwise only the owner", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");

    const mine = (await add(accountant.token, {})).body.expense;
    expect((await api().delete(`/api/expenses/${mine.id}`).set(auth(accountant.token))).status).toBe(204);

    const older = (await add(accountant.token, {})).body.expense;
    await prisma.expense.update({
      where: { id: older.id },
      data: { createdAt: new Date(Date.now() - UNDO_WINDOW_MS - 1000) },
    });
    const late = await api().delete(`/api/expenses/${older.id}`).set(auth(accountant.token));
    expect(late.status).toBe(403);

    const ownersPick = (await add(owner.token, {})).body.expense;
    expect((await api().delete(`/api/expenses/${ownersPick.id}`).set(auth(accountant.token))).status).toBe(403);

    expect((await api().delete(`/api/expenses/${older.id}`).set(auth(owner.token))).status).toBe(204);
  });

  it("another company's expenses are out of reach", async () => {
    const mine = await ownerSession();
    const theirs = await ownerSession();
    const their = (await add(theirs.token, { status: "due" })).body.expense;

    expect((await api().get("/api/expenses").set(auth(mine.token))).body.total).toBe(0);
    expect((await api().post(`/api/expenses/${their.id}/pay`).set(auth(mine.token)).send({ paidFrom: "cash" })).status).toBe(404);
    expect((await api().delete(`/api/expenses/${their.id}`).set(auth(mine.token))).status).toBe(404);
    expect((await api().get("/api/expenses/stats").set(auth(mine.token))).body.stats.total).toBe("0.00");
  });
});
