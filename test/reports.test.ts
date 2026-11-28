import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange, quarterRange, yearRange } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

// Every date is relative to today (Cairo), so the tests never depend on the calendar.
const today = () => businessToday();
const monthStart = (offset = 0) => monthRange(today(), offset).start;
const monthEnd = (offset = 0) => monthRange(today(), offset).end;
const monthKey = (offset = 0) => monthStart(offset).slice(0, 7);

type Opts = { issueDate?: string; terms?: number; send?: boolean };

/** A company with its owner, plus shortcuts to fill it with data. */
async function company() {
  const owner = await ownerSession();
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await api().post(path).set(auth(owner.token)).send(body);
    if (res.status !== 201 && res.status !== 200) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return {
    owner,
    get: (path: string) => api().get(path).set(auth(owner.token)),
    customer: async (name: string) => (await post("/api/customers", { name })).customer as { id: string; name: string },
    /** One line of `unitPrice`; with VAT on, the total is unitPrice x 1.14. */
    invoice: async (customerId: string, unitPrice: string, { issueDate = today(), terms = 30, send = true }: Opts = {}) =>
      (
        await post("/api/invoices", {
          customerId,
          issueDate,
          terms,
          send,
          items: [{ description: "خدمة", quantity: "1", unitPrice }],
        })
      ).invoice as { id: string; number: number; total: string },
    pay: async (invoiceId: string, amount: string, { date = today(), method = "bank" } = {}) =>
      (await post("/api/payments", { invoiceId, amount, date, method })).payment as { id: string; number: string },
    expense: (category: string, amount: string, { date = today(), status = "paid" } = {}) =>
      post("/api/expenses", { title: "مصروف", category, amount, date, status }),
    cancel: (invoiceId: string) => post(`/api/invoices/${invoiceId}/cancel`, {}),
    turnVatOff: async () => {
      const settings = (await api().get("/api/settings").set(auth(owner.token))).body.settings;
      const res = await api()
        .patch("/api/settings")
        .set(auth(owner.token))
        .send({ taxes: { ...settings.taxes, vatEnabled: false } });
      if (res.status !== 200) throw new Error(`settings: ${res.status}`);
    },
  };
}

describe("date ranges", () => {
  it("quarterRange: calendar quarters, shifted across years", () => {
    expect(quarterRange("2026-11-19")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(quarterRange("2026-05-01")).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterRange("2026-01-15", -1)).toEqual({ start: "2025-10-01", end: "2025-12-31" });
    expect(quarterRange("2026-12-31", 1)).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(quarterRange("2024-03-31")).toEqual({ start: "2024-01-01", end: "2024-03-31" });
  });

  it("yearRange: optional offset, same result without it", () => {
    expect(yearRange("2026-11-19")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(yearRange("2026-11-19", -1)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });
});

describe("permissions", () => {
  it("owner and accountant see every report; sales and viewer get 403", async () => {
    const c = await company();
    const customer = await c.customer("شركة النيل");
    const accountant = await teamMember(c.owner.token, "accountant");
    const sales = await teamMember(c.owner.token, "sales");
    const viewer = await teamMember(c.owner.token, "viewer");
    const routes = [
      "/api/reports/summary",
      "/api/reports/aging",
      "/api/reports/vat",
      `/api/reports/statement?customerId=${customer.id}`,
    ];

    for (const path of routes) {
      for (const { token } of [c.owner, accountant]) {
        expect((await api().get(path).set(auth(token))).status, path).toBe(200);
      }
      for (const { token } of [sales, viewer]) {
        expect((await api().get(path).set(auth(token))).status, path).toBe(403);
      }
      expect((await api().get(path)).status, path).toBe(401);
    }
  });
});

describe("company isolation", () => {
  it("another company's customers, invoices, payments and expenses never show up", async () => {
    const mine = await company();
    const theirs = await company();
    const theirCustomer = await theirs.customer("عميلهم");
    const inv = await theirs.invoice(theirCustomer.id, "1000");
    await theirs.invoice(theirCustomer.id, "500", { issueDate: addDays(today(), -40), terms: 0 });
    await theirs.pay(inv.id, "140");
    await theirs.expense("rent", "800");

    const summary = (await mine.get("/api/reports/summary")).body.summary;
    expect(summary).toMatchObject({ revenue: "0.00", expenses: "0.00", collected: "0.00", topCustomers: [] });
    expect(summary.series.every((m: { revenue: string }) => m.revenue === "0.00")).toBe(true);

    const aging = (await mine.get("/api/reports/aging")).body.aging;
    expect(aging).toMatchObject({ rows: [], total: "0.00", overdue: "0.00", overdueCustomers: 0 });

    const vat = (await mine.get("/api/reports/vat")).body.vat;
    expect(vat).toMatchObject({ output: "0.00", taxableSales: "0.00", invoicesCount: 0 });

    const statement = await mine.get(`/api/reports/statement?customerId=${theirCustomer.id}`);
    expect(statement.status).toBe(404);
    expect(statement.body.error.code).toBe("NOT_FOUND");
    // Their own statement works, so the 404 above is about the company.
    expect((await theirs.get(`/api/reports/statement?customerId=${theirCustomer.id}`)).status).toBe(200);
    expect((await theirs.get("/api/reports/summary")).body.summary.revenue).toBe("1000.00");
  });
});

describe("the period query", () => {
  it("defaults to this month (Cairo); takes YYYY-MM, thisQuarter and thisYear", async () => {
    const c = await company();
    const customer = await c.customer("شركة النيل");

    const current = { key: monthKey(), start: monthStart(), end: monthEnd() };
    const byDefault = (await c.get("/api/reports/summary")).body.summary;
    expect(byDefault.period).toEqual(current);
    expect(byDefault.currentMonth).toBe(monthKey());
    expect(byDefault.previous).toMatchObject({ start: monthStart(-1), end: monthEnd(-1) });
    expect((await c.get("/api/reports/vat")).body.vat.period).toEqual(current);
    const statement = (await c.get(`/api/reports/statement?customerId=${customer.id}`)).body.statement;
    expect(statement).toMatchObject({ period: current, currentMonth: monthKey() });

    // A leap-year February, and the month before it.
    const feb = (await c.get("/api/reports/summary?period=2024-02")).body.summary;
    expect(feb.period).toEqual({ key: "2024-02", start: "2024-02-01", end: "2024-02-29" });
    expect(feb.previous).toMatchObject({ start: "2024-01-01", end: "2024-01-31" });
    expect(feb.series.map((m: { month: string }) => m.month)).toEqual(["2023-09", "2023-10", "2023-11", "2023-12", "2024-01", "2024-02"]);
    expect(feb.currentMonth).toBe(monthKey());

    // This month as YYYY-MM is the same as the default.
    expect((await c.get(`/api/reports/summary?period=${monthKey()}`)).body.summary.period).toEqual(current);

    const [y, m] = today().split("-").map(Number) as [number, number];
    const firstMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const quarter = (await c.get("/api/reports/summary?period=thisQuarter")).body.summary;
    expect(quarter.period).toEqual({
      key: "thisQuarter",
      start: `${y}-${String(firstMonth).padStart(2, "0")}-01`,
      end: monthRange(`${y}-${String(firstMonth + 2).padStart(2, "0")}-01`).end,
    });
    expect(quarter.previous.start).toBe(monthRange(quarter.period.start, -3).start);
    expect(quarter.previous.end).toBe(monthRange(quarter.period.start, -1).end);

    const year = (await c.get("/api/reports/summary?period=thisYear")).body.summary;
    expect(year.period).toEqual({ key: "thisYear", start: `${y}-01-01`, end: `${y}-12-31` });
    expect(year.previous).toMatchObject({ start: `${y - 1}-01-01`, end: `${y - 1}-12-31` });
    // The chart never runs past this month.
    expect(year.series.at(-1).month).toBe(monthKey());
    expect(quarter.series.at(-1).month).toBe(monthKey());
  });

  it("refuses a malformed period or a future month (400) on every period route", async () => {
    const c = await company();
    const customer = await c.customer("شركة النيل");
    const bad = ["2026-13", "2026-1", "26-01", "0999-01", "thisMonth", "lastYear", "", monthKey(1), "2999-12"];
    const routes = ["/api/reports/summary?", "/api/reports/vat?", `/api/reports/statement?customerId=${customer.id}&`];

    for (const route of routes) {
      for (const period of bad) {
        const res = await c.get(`${route}period=${encodeURIComponent(period)}`);
        expect(res.status, `${route} ${period}`).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
      const twice = await c.get(`${route}period=${monthKey()}&period=${monthKey()}`);
      expect(twice.status, `${route} repeated`).toBe(400);
    }
  });
});

describe("GET /api/reports/summary", () => {
  it("profit and loss: lines, totals, margin, change, collected, chart and top customers", async () => {
    const c = await company();
    const nile = await c.customer("شركة النيل");
    const rowad = await c.customer("شركة الرواد");
    const other = await c.customer("عميل آخر");

    // This month: 1000 + 500 (nile) and 3000 (rowad) before VAT = 4500.
    const a = await c.invoice(nile.id, "1000");
    await c.invoice(nile.id, "500", { issueDate: monthStart() });
    const b = await c.invoice(rowad.id, "3000");
    // A draft and a cancelled invoice never count.
    await c.invoice(other.id, "9999", { send: false });
    await c.cancel((await c.invoice(other.id, "7777")).id);
    // Last month: 2000.
    const old = await c.invoice(nile.id, "2000", { issueDate: monthStart(-1) });

    // Expenses this month 3500 (purchases are the cost of sales; a due expense counts too).
    await c.expense("purchases", "900");
    await c.expense("salaries", "1500");
    await c.expense("rent", "800");
    await c.expense("marketing", "200");
    await c.expense("software", "100", { status: "due" });
    // Last month 1000.
    await c.expense("utilities", "1000", { date: monthStart(-1) });

    // Collected = cleared payments dated in the period; a pending cheque isn't.
    await c.pay(a.id, "1140");
    await c.pay(b.id, "1000", { method: "cheque" });
    await c.pay(old.id, "500", { date: monthStart(-1) });
    await c.pay(old.id, "300");

    // Top customers use the customer's current name.
    await api().patch(`/api/customers/${rowad.id}`).set(auth(c.owner.token)).send({ name: "شركة الرواد الجديدة" });

    const res = await c.get("/api/reports/summary");
    expect(res.status).toBe(200);
    const s = res.body.summary;

    expect(s.lines).toEqual([
      { key: "salesRevenue", kind: "income", amount: "4500.00" },
      { key: "purchases", kind: "cost", amount: "900.00" },
      { key: "salaries", kind: "expense", amount: "1500.00" },
      { key: "rent", kind: "expense", amount: "800.00" },
      { key: "utilities", kind: "expense", amount: "0.00" },
      { key: "marketing", kind: "expense", amount: "200.00" },
      { key: "software", kind: "expense", amount: "100.00" },
    ]);
    expect(s).toMatchObject({
      revenue: "4500.00",
      cost: "900.00",
      operating: "2600.00",
      expenses: "3500.00",
      grossProfit: "3600.00",
      netProfit: "1000.00",
      marginPct: 22, // 1000 / 4500 = 22.2%
      previous: { start: monthStart(-1), end: monthEnd(-1), revenue: "2000.00", expenses: "1000.00", netProfit: "1000.00" },
      change: { revenue: 125, expenses: 250, netProfit: 0 },
      collected: "1440.00",
    });

    expect(s.series.map((m: { month: string }) => m.month)).toEqual([-5, -4, -3, -2, -1, 0].map((o) => monthKey(o)));
    expect(s.series.at(-1)).toEqual({ month: monthKey(), revenue: "4500.00", expenses: "3500.00" });
    expect(s.series.at(-2)).toEqual({ month: monthKey(-1), revenue: "2000.00", expenses: "1000.00" });
    for (const m of s.series.slice(0, 4)) expect(m).toMatchObject({ revenue: "0.00", expenses: "0.00" });

    expect(s.topCustomers).toEqual([
      { id: rowad.id, name: "شركة الرواد الجديدة", invoicesCount: 1, revenue: "3000.00" },
      { id: nile.id, name: "شركة النيل", invoicesCount: 2, revenue: "1500.00" },
    ]);

    // The dashboard and the expenses page show the same month the same way.
    const { financials } = (await c.get("/api/dashboard")).body;
    expect(financials).toMatchObject({
      revenue: s.revenue,
      expenses: s.expenses,
      netProfit: s.netProfit,
      revenueChange: s.change.revenue,
      expensesChange: s.change.expenses,
      netProfitChange: s.change.netProfit,
    });
    expect(financials.chart).toEqual(s.series);
    const { stats } = (await c.get("/api/expenses/stats")).body;
    expect(stats).toMatchObject({ revenue: s.revenue, total: s.expenses, netProfit: s.netProfit });

    // Last month on its own: nothing the month before, so no change to show.
    const last = (await c.get(`/api/reports/summary?period=${monthKey(-1)}`)).body.summary;
    expect(last).toMatchObject({
      period: { key: monthKey(-1), start: monthStart(-1), end: monthEnd(-1) },
      revenue: "2000.00",
      cost: "0.00",
      expenses: "1000.00",
      netProfit: "1000.00",
      marginPct: 50,
      previous: { revenue: "0.00", expenses: "0.00", netProfit: "0.00" },
      change: { revenue: null, expenses: null, netProfit: null },
      collected: "500.00",
      topCustomers: [{ id: nile.id, name: "شركة النيل", invoicesCount: 1, revenue: "2000.00" }],
    });
    expect(last.lines.find((l: { key: string }) => l.key === "utilities").amount).toBe("1000.00");
    expect(last.series.at(-1)).toEqual({ month: monthKey(-1), revenue: "2000.00", expenses: "1000.00" });

    // Quarter and year: last month is in them or in the previous one, depending on the calendar.
    for (const [key, range, prev] of [
      ["thisQuarter", quarterRange(today()), quarterRange(today(), -1)],
      ["thisYear", yearRange(today()), yearRange(today(), -1)],
    ] as const) {
      const lastMonthInside = monthStart(-1) >= range.start;
      const p = (await c.get(`/api/reports/summary?period=${key}`)).body.summary;
      expect(p, key).toMatchObject({
        period: { key, ...range },
        revenue: lastMonthInside ? "6500.00" : "4500.00",
        expenses: lastMonthInside ? "4500.00" : "3500.00",
        collected: lastMonthInside ? "1940.00" : "1440.00",
        previous: { ...prev, revenue: lastMonthInside ? "0.00" : "2000.00" },
      });
      expect(p.series).toEqual(s.series);
    }
  });

  it("no revenue: margin is null and the change against zero is null", async () => {
    const c = await company();
    await c.expense("rent", "500");
    const s = (await c.get("/api/reports/summary")).body.summary;
    expect(s).toMatchObject({
      revenue: "0.00",
      expenses: "500.00",
      netProfit: "-500.00",
      marginPct: null,
      change: { revenue: null, expenses: null, netProfit: null },
    });
  });

  it("this quarter / this year count up to this month: an expense entered ahead of time waits for its month", async () => {
    const c = await company();
    await c.expense("rent", "500");
    await c.expense("rent", "9000", { date: monthStart(1), status: "due" }); // next month's rent, entered now

    for (const period of ["thisQuarter", "thisYear"]) {
      const s = (await c.get(`/api/reports/summary?period=${period}`)).body.summary;
      expect(s.expenses, period).toBe("500.00");
      expect(s.period.end, period).toBe(period === "thisQuarter" ? quarterRange(today()).end : yearRange(today()).end);
    }
    // The month report agrees: this month has only the 500.
    expect((await c.get("/api/reports/summary")).body.summary.expenses).toBe("500.00");
  });

  it("top customers: at most 5, by revenue, equal revenue by name", async () => {
    const c = await company();
    const make = async (name: string, ...amounts: string[]) => {
      const customer = await c.customer(name);
      for (const amount of amounts) await c.invoice(customer.id, amount);
      return customer;
    };
    const delta = await make("Delta", "300", "300");
    const echo = await make("Echo", "500");
    const foxtrot = await make("Foxtrot", "400");
    const beta = await make("Beta", "300");
    const alpha = await make("Alpha", "300");
    await make("Gamma", "100");

    const top = (await c.get("/api/reports/summary")).body.summary.topCustomers;
    expect(top.map((t: { id: string }) => t.id)).toEqual([delta.id, echo.id, foxtrot.id, alpha.id, beta.id]);
    expect(top[0]).toEqual({ id: delta.id, name: "Delta", invoicesCount: 2, revenue: "600.00" });
  });
});

describe("GET /api/reports/aging", () => {
  it("buckets what is owed by days past due, per customer, and matches the invoice stats", async () => {
    const c = await company();
    const a = await c.customer("عميل أ");
    const b = await c.customer("عميل ب");
    const d = await c.customer("عميل د");
    const settled = await c.customer("عميل مسدد");
    const ago = (days: number) => addDays(today(), -days);

    // a: due today (not overdue yet), 1 day late (partly paid), exactly 30 days late.
    await c.invoice(a.id, "1000", { terms: 0 }); // 1140
    const oneDay = await c.invoice(a.id, "2000", { issueDate: ago(1), terms: 0 }); // 2280
    await c.pay(oneDay.id, "280"); // 2000 left
    await c.invoice(a.id, "100", { issueDate: ago(45), terms: 15 }); // 114, due 30 days ago
    // b: 31 days, exactly 60 days, and 61 days late (with a pending cheque).
    await c.invoice(b.id, "1000", { issueDate: ago(31), terms: 0 }); // 1140
    await c.invoice(b.id, "500", { issueDate: ago(90), terms: 30 }); // 570, due 60 days ago
    const oldest = await c.invoice(b.id, "3000", { issueDate: ago(91), terms: 30 }); // 3420, due 61 days ago
    await c.pay(oldest.id, "420", { method: "cheque" }); // 3000 left
    // d: not due for 30 days.
    await c.invoice(d.id, "1000"); // 1140
    // Paid, draft and cancelled invoices owe nothing.
    const paid = await c.invoice(settled.id, "1000", { issueDate: ago(100), terms: 0 });
    await c.pay(paid.id, "1140", { date: ago(100) });
    await c.invoice(settled.id, "500", { issueDate: ago(100), terms: 0, send: false });
    await c.cancel((await c.invoice(settled.id, "700", { issueDate: ago(100), terms: 0 })).id);

    const res = await c.get("/api/reports/aging");
    expect(res.status).toBe(200);
    const aging = res.body.aging;

    expect(aging.asOf).toBe(today());
    expect(aging.buckets).toEqual([
      { key: "notDue", amount: "2280.00" },
      { key: "d1_30", amount: "2114.00" },
      { key: "d31_60", amount: "1710.00" },
      { key: "d60plus", amount: "3000.00" },
    ]);
    expect(aging.rows).toEqual([
      { id: b.id, name: "عميل ب", notDue: "0.00", d1_30: "0.00", d31_60: "1710.00", d60plus: "3000.00", total: "4710.00", invoiceCount: 3, maxDaysOverdue: 61 },
      { id: a.id, name: "عميل أ", notDue: "1140.00", d1_30: "2114.00", d31_60: "0.00", d60plus: "0.00", total: "3254.00", invoiceCount: 3, maxDaysOverdue: 30 },
      { id: d.id, name: "عميل د", notDue: "1140.00", d1_30: "0.00", d31_60: "0.00", d60plus: "0.00", total: "1140.00", invoiceCount: 1, maxDaysOverdue: 0 },
    ]);
    expect(aging).toMatchObject({ total: "9104.00", overdue: "6824.00", overdueCustomers: 2 });

    // Same numbers as the invoices page.
    const { stats } = (await c.get("/api/invoices/stats")).body;
    expect(aging.total).toBe(stats.outstanding);
    expect(aging.overdue).toBe(stats.overdue);
  });
});

describe("GET /api/reports/vat", () => {
  it("sums the stored VAT of issued invoices; VAT-off invoices are exempt sales", async () => {
    const c = await company();
    const customer = await c.customer("شركة النيل");

    await c.invoice(customer.id, "1000"); // VAT 140.00
    // 0.04 x 14% = 0.0056 -> 0.01 each; recomputing on the total would give 0.01 less.
    await c.invoice(customer.id, "0.04");
    await c.invoice(customer.id, "0.04");
    await c.invoice(customer.id, "5000", { send: false }); // draft
    await c.cancel((await c.invoice(customer.id, "2000")).id);
    await c.invoice(customer.id, "2000", { issueDate: monthStart(-1) }); // last month, VAT 280.00

    // VAT turned off in the settings: the invoice carries vatRate 0.
    await c.turnVatOff();
    const exempt = await c.invoice(customer.id, "500");
    expect(exempt.total).toBe("500.00");

    const res = await c.get("/api/reports/vat");
    expect(res.status).toBe(200);
    expect(res.body.vat).toEqual({
      period: { key: monthKey(), start: monthStart(), end: monthEnd() },
      currentMonth: monthKey(),
      rate: 14,
      rates: [14],
      output: "140.02",
      input: "0.00",
      due: "140.02",
      taxableSales: "1000.08",
      exemptSales: "500.00",
      taxablePurchases: "0.00",
      purchasesCount: 0,
      invoicesCount: 4,
      filingDueDate: monthEnd(1),
    });

    const last = (await c.get(`/api/reports/vat?period=${monthKey(-1)}`)).body.vat;
    expect(last).toMatchObject({ output: "280.00", due: "280.00", taxableSales: "2000.00", exemptSales: "0.00", invoicesCount: 1 });

    // Filing is due by the end of the month after the period.
    expect((await c.get("/api/reports/vat?period=2024-12")).body.vat.filingDueDate).toBe("2025-01-31");
    expect((await c.get("/api/reports/vat?period=2024-01")).body.vat.filingDueDate).toBe("2024-02-29");
    const quarter = (await c.get("/api/reports/vat?period=thisQuarter")).body.vat;
    expect(quarter.filingDueDate).toBe(monthRange(quarterRange(today()).end, 1).end);
  });
});

describe("GET /api/reports/statement", () => {
  it("opening balance, rows with a running balance, closing = the customer's balance", async () => {
    const c = await company();
    const customer = await c.customer("شركة النيل");
    const someoneElse = await c.customer("عميل آخر");
    const m2 = monthStart(-2);
    const lastStart = monthStart(-1);
    const lastEnd = monthEnd(-1);

    // Before last month: 1140 + 2280 invoiced, 140 paid and a 280 cheque still pending.
    const i1 = await c.invoice(customer.id, "1000", { issueDate: m2 }); // INV-1, 1140
    const i2 = await c.invoice(customer.id, "2000", { issueDate: m2 }); // INV-2, 2280
    await c.pay(i1.id, "140", { date: m2 }); // PAY-0001
    await c.pay(i2.id, "280", { date: m2, method: "cheque" }); // PAY-0002, pending

    // Last month.
    const i3 = await c.invoice(customer.id, "500", { issueDate: lastEnd }); // INV-3, 570
    const i4 = await c.invoice(customer.id, "1000", { issueDate: lastStart }); // INV-4, 1140
    await c.pay(i1.id, "1000", { date: lastStart }); // PAY-0003, i1 now paid
    await c.pay(i2.id, "1000", { date: lastEnd, method: "cheque" }); // PAY-0004, pending
    await c.pay(i4.id, "140", { date: lastEnd }); // PAY-0005, partial
    // Not in the statement: a draft, a cancelled invoice, another customer's invoice.
    await c.invoice(customer.id, "999", { issueDate: lastStart, send: false });
    await c.cancel((await c.invoice(customer.id, "888", { issueDate: lastStart })).id);
    await c.invoice(someoneElse.id, "777", { issueDate: lastStart });

    // This month.
    await c.invoice(customer.id, "1000"); // INV-8, 1140
    await c.pay(i3.id, "100"); // PAY-0006

    const res = await c.get(`/api/reports/statement?customerId=${customer.id}&period=${monthKey(-1)}`);
    expect(res.status).toBe(200);
    const s = res.body.statement;
    expect(s).toMatchObject({
      customer: { id: customer.id, name: "شركة النيل" },
      period: { key: monthKey(-1), start: lastStart, end: lastEnd },
      opening: "3000.00",
      invoiced: "1710.00",
      paid: "2140.00",
      closing: "2570.00",
    });
    // By date; on the same day invoices before payments, even with a higher number.
    expect(s.txns).toEqual([
      { id: i4.id, date: lastStart, type: "invoice", ref: "INV-4", invoiceRef: null, amount: "1140.00", balance: "4140.00", pending: false },
      { id: expect.any(String), date: lastStart, type: "payment", ref: "PAY-0003", invoiceRef: "INV-1", amount: "1000.00", balance: "3140.00", pending: false },
      { id: i3.id, date: lastEnd, type: "invoice", ref: "INV-3", invoiceRef: null, amount: "570.00", balance: "3710.00", pending: false },
      { id: expect.any(String), date: lastEnd, type: "payment", ref: "PAY-0004", invoiceRef: "INV-2", amount: "1000.00", balance: "2710.00", pending: true },
      { id: expect.any(String), date: lastEnd, type: "payment", ref: "PAY-0005", invoiceRef: "INV-4", amount: "140.00", balance: "2570.00", pending: false },
    ]);

    // This month starts where last month ended, and ends at the customer's balance.
    const now = (await c.get(`/api/reports/statement?customerId=${customer.id}`)).body.statement;
    expect(now).toMatchObject({ opening: "2570.00", invoiced: "1140.00", paid: "100.00", closing: "3610.00" });
    expect(now.txns.map((t: { ref: string; balance: string }) => [t.ref, t.balance])).toEqual([
      ["INV-8", "3710.00"],
      ["PAY-0006", "3610.00"],
    ]);
    const balance = (await c.get(`/api/customers/${customer.id}`)).body.customer.balance;
    expect(balance).toBe("3610.00");
    expect(now.closing).toBe(balance);
    for (const period of ["thisQuarter", "thisYear"]) {
      const p = (await c.get(`/api/reports/statement?customerId=${customer.id}&period=${period}`)).body.statement;
      expect(p.closing, period).toBe(balance);
    }

    // Before anything happened: all zero.
    const early = (await c.get(`/api/reports/statement?customerId=${customer.id}&period=2020-01`)).body.statement;
    expect(early).toMatchObject({ opening: "0.00", invoiced: "0.00", paid: "0.00", closing: "0.00", txns: [] });
  });

  it("needs a customer of this company", async () => {
    const c = await company();
    expect((await c.get("/api/reports/statement")).status).toBe(400);
    expect((await c.get("/api/reports/statement?customerId=")).status).toBe(400);
    expect((await c.get("/api/reports/statement?customerId=not-a-uuid")).status).toBe(404);
    const missing = await c.get("/api/reports/statement?customerId=7b0c7f8e-9a43-4a8e-9a0e-1d7a8f1f2c3d");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});
