import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
const lastMonthDay = () => addDays(monthRange(today(), -1).start, 9);
const lastMonth = () => monthRange(today(), -1).start.slice(0, 7);

async function ok(res: { status: number; body: any }, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const send = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(path).set(auth(token)).send(body);

/**
 * Last month: capital 50,000 into the bank; invoice 10,000 + 1,400 VAT; 4,000 paid
 * by bank transfer; rent 3,000 from the bank; purchases 1,500 saved as due.
 * This month: the purchases paid from the cash box; a 2,000 cheque (not cleared).
 */
async function company() {
  const session = await ownerSession();
  const { token } = session;
  const { accounts } = await ok(await api().get("/api/ledger/accounts").set(auth(token)));
  const id = Object.fromEntries(accounts.map((a: { key: string; id: string }) => [a.key, a.id])) as Record<string, string>;
  const day = lastMonthDay();

  await ok(await send(token, "/api/ledger/entries", {
    date: day,
    memo: "رأس المال",
    lines: [{ accountId: id.bank, debit: "50000" }, { accountId: id.capital, credit: "50000" }],
  }), 201);
  const customer = (await ok(await send(token, "/api/customers", { name: "شركة النيل", city: "القاهرة" }), 201)).customer;
  const invoice = (await ok(await send(token, "/api/invoices", {
    customerId: customer.id,
    issueDate: day,
    terms: 30,
    send: true,
    items: [{ description: "خدمة", quantity: "1", unitPrice: "10000" }],
  }), 201)).invoice;
  await ok(await send(token, "/api/payments", { invoiceId: invoice.id, amount: "4000", date: day, method: "bank" }), 201);
  await ok(await send(token, "/api/expenses", { title: "إيجار", category: "rent", amount: "3000", date: day, status: "paid", paidFrom: "bank" }), 201);
  const due = (await ok(await send(token, "/api/expenses", { title: "خامات", category: "purchases", amount: "1500", date: day, status: "due" }), 201)).expense;
  await ok(await send(token, `/api/expenses/${due.id}/pay`, { paidFrom: "cash" }));
  const cheque = (await ok(await send(token, "/api/payments", { invoiceId: invoice.id, amount: "2000", date: today(), method: "cheque" }), 201)).payment;
  return { ...session, id, cheque };
}

const amounts = (rows: { account: { key: string }; amount: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.account.key, r.amount]));

describe("balance sheet", () => {
  it("at the end of last month: assets equal liabilities plus equity, with the year's profit", async () => {
    const { token } = await company();
    const { balanceSheet: bs } = await ok(await api().get(`/api/reports/balance-sheet?period=${lastMonth()}`).set(auth(token)));
    expect(bs.asOf).toBe(monthRange(today(), -1).end);
    expect(amounts(bs.assets.rows)).toEqual({ bank: "51000.00", customers: "7400.00" });
    expect(bs.assets.total).toBe("58400.00");
    expect(amounts(bs.liabilities.rows)).toEqual({ suppliers: "1500.00", vat: "1400.00" });
    expect(amounts(bs.equity.rows)).toEqual({ capital: "50000.00" });
    // 10,000 sales - 3,000 rent - 1,500 purchases, all in the fiscal year of that day.
    expect(bs.equity).toMatchObject({ yearProfit: "5500.00", priorYearsProfit: "0.00" });
    expect(bs.equity.total).toBe("55500.00");
    expect(bs.totalLiabilitiesAndEquity).toBe("58400.00");
    expect(bs.balanced).toBe(true);
  });

  it("today: the purchases paid from the cash box, the cheque still waiting", async () => {
    const { token } = await company();
    const { balanceSheet: bs } = await ok(await api().get("/api/reports/balance-sheet").set(auth(token)));
    expect(bs.asOf).toBe(today());
    expect(amounts(bs.assets.rows)).toEqual({
      cashbox: "-1500.00",
      bank: "51000.00",
      cheques: "2000.00",
      customers: "5400.00",
    });
    expect(amounts(bs.liabilities.rows)).toEqual({ vat: "1400.00" });
    expect(bs.assets.total).toBe("56900.00");
    expect(bs.totalLiabilitiesAndEquity).toBe("56900.00");
    expect(bs.balanced).toBe(true);
  });

  it("a fiscal year starting this month moves last month's profit to the years before", async () => {
    const { token, companyId } = await company();
    await prisma.company.update({ where: { id: companyId }, data: { fiscalStartMonth: Number(today().slice(5, 7)) } });
    const { balanceSheet: bs } = await ok(await api().get("/api/reports/balance-sheet").set(auth(token)));
    expect(bs.fiscalYear.start).toBe(monthRange(today()).start);
    expect(bs.equity).toMatchObject({ priorYearsProfit: "5500.00", yearProfit: "0.00", total: "55500.00" });
    expect(bs.balanced).toBe(true);
  });
});

describe("cash flow", () => {
  it("last month: the owner's capital, customers' payments and the rent", async () => {
    const { token } = await company();
    const { cashFlow: cf } = await ok(await api().get(`/api/reports/cash-flow?period=${lastMonth()}`).set(auth(token)));
    expect(cf).toMatchObject({ opening: "0.00", closing: "51000.00", net: "51000.00" });
    expect(cf.lines).toEqual([
      { section: "operating", key: "customers", amount: "4000.00" },
      { section: "operating", key: "rent", amount: "-3000.00" },
      { section: "financing", key: "capital", amount: "50000.00" },
    ]);
    expect(cf.totals).toEqual({ operating: "1000.00", investing: "0.00", financing: "50000.00" });
  });

  it("this month: a paid due expense, a cleared cheque, a loan; moving cash between accounts isn't a flow", async () => {
    const { token, id, cheque } = await company();
    await ok(await send(token, `/api/payments/${cheque.id}/clear`));
    await ok(await send(token, "/api/ledger/entries", {
      date: today(),
      memo: "سحب من البنك للخزينة",
      lines: [{ accountId: id.cashbox, debit: "1000" }, { accountId: id.bank, credit: "1000" }],
    }), 201);
    await ok(await send(token, "/api/ledger/entries", {
      date: today(),
      memo: "قرض",
      lines: [{ accountId: id.bank, debit: "5000" }, { accountId: id.loans, credit: "5000" }],
    }), 201);
    await ok(await send(token, "/api/ledger/entries", {
      date: today(),
      memo: "شراء جهاز",
      lines: [{ accountId: id.fixedAssets, debit: "800" }, { accountId: id.cashbox, credit: "800" }],
    }), 201);

    const { cashFlow: cf } = await ok(await api().get("/api/reports/cash-flow").set(auth(token)));
    expect(cf.lines).toEqual([
      { section: "operating", key: "customers", amount: "2000.00" },
      { section: "operating", key: "purchases", amount: "-1500.00" },
      { section: "investing", key: "fixedAssets", amount: "-800.00" },
      { section: "financing", key: "loans", amount: "5000.00" },
    ]);
    expect(cf).toMatchObject({ opening: "51000.00", net: "4700.00", closing: "55700.00" });
    expect(cf.accounts).toEqual([
      { key: "cashbox", opening: "0.00", closing: "-1300.00" },
      { key: "bank", opening: "51000.00", closing: "57000.00" },
      { key: "wallet", opening: "0.00", closing: "0.00" },
    ]);
  });

  it("is for the owner and the accountant", async () => {
    const { token } = await ownerSession();
    const sales = await teamMember(token, "sales");
    expect((await api().get("/api/reports/cash-flow").set(auth(sales.token))).status).toBe(403);
    expect((await api().get("/api/reports/balance-sheet").set(auth(sales.token))).status).toBe(403);
    const accountant = await teamMember(token, "accountant");
    expect((await api().get("/api/reports/balance-sheet").set(auth(accountant.token))).status).toBe(200);
  });
});
