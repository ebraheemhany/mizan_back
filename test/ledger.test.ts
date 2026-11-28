import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
/** A day in last month (the 10th), and that month as "YYYY-MM". */
const lastMonthDay = () => addDays(monthRange(today(), -1).start, 9);
const lastMonth = () => monthRange(today(), -1).start.slice(0, 7);
const thisMonth = () => today().slice(0, 7);

type Account = { id: string; code: string; key: string | null; name: string | null; balance: string; system: boolean };
type Line = { id: string; key: string | null; debit: string; credit: string };
type Entry = {
  source: string;
  id: string;
  date: string;
  status: string;
  amount: string;
  ref: string | null;
  memo: string | null;
  party: string | null;
  lines: Line[];
};

const get = (token: string, path: string) => api().get(`/api/ledger${path}`).set(auth(token));
const post = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/ledger${path}`).set(auth(token)).send(body);

async function ok<T = any>(res: { status: number; body: any }, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function customerOf(token: string, name = "شركة النيل") {
  const res = await api().post("/api/customers").set(auth(token)).send({ name, city: "الجيزة" });
  return (await ok(res, 201)).customer as { id: string };
}

async function invoice(token: string, customerId: string, opts: { issueDate?: string; send?: boolean; price?: string } = {}) {
  const res = await api()
    .post("/api/invoices")
    .set(auth(token))
    .send({
      customerId,
      issueDate: opts.issueDate ?? today(),
      terms: 30,
      send: opts.send ?? true,
      items: [{ description: "خدمة", quantity: "1", unitPrice: opts.price ?? "1000" }],
    });
  return (await ok(res, 201)).invoice as { id: string; number: number; displayNumber: string; total: string };
}

const payRequest = (token: string, invoiceId: string, body: Record<string, unknown>) =>
  api().post("/api/payments").set(auth(token)).send({ invoiceId, date: today(), method: "cash", ...body });

async function pay(token: string, invoiceId: string, body: Record<string, unknown>) {
  return (await ok(await payRequest(token, invoiceId, body), 201)).payment as { id: string };
}

const expenseRequest = (token: string, body: Record<string, unknown>) =>
  api()
    .post("/api/expenses")
    .set(auth(token))
    .send({ title: "مصروف", category: "rent", amount: "1000", date: today(), status: "paid", paidFrom: "bank", ...body });

async function expense(token: string, body: Record<string, unknown>) {
  return (await ok(await expenseRequest(token, body), 201)).expense as { id: string };
}

async function chart(token: string) {
  const { accounts } = await ok<{ accounts: Account[] }>(await get(token, "/accounts"));
  return Object.fromEntries(accounts.map((a) => [a.key ?? a.code, a])) as Record<string, Account>;
}

/** Balances by built-in key, leaving out the zero ones. */
async function balances(token: string) {
  const accounts = await chart(token);
  return Object.fromEntries(Object.entries(accounts).filter(([, a]) => a.balance !== "0.00").map(([k, a]) => [k, a.balance]));
}

async function entries(token: string, query = "") {
  return ok<{ items: Entry[]; total: number }>(await get(token, `/entries?pageSize=100${query}`));
}

const linesOf = (e: Entry) => e.lines.map((l) => `${l.key ?? "custom"} ${l.debit}/${l.credit}`);

async function manual(token: string, lines: { accountId: string; debit?: string; credit?: string }[], extra: Record<string, unknown> = {}) {
  return (await ok(await post(token, "/entries", { date: today(), memo: "قيد يدوي", lines, ...extra }), 201)).entry as Entry;
}

describe("chart of accounts", () => {
  it("a new company gets the built-in chart, every balance at zero", async () => {
    const { token } = await ownerSession();
    const { accounts } = await ok<{ accounts: Account[] }>(await get(token, "/accounts"));
    // 21 for invoicing and expenses, 4 for payroll (advances, salaries payable, insurance, tax).
    expect(accounts).toHaveLength(26);
    expect(accounts.map((a) => a.code)).toEqual([...accounts.map((a) => a.code)].sort());
    expect(accounts.slice(0, 5).map((a) => a.key)).toEqual(["cashbox", "bank", "wallet", "cheques", "customers"]);
    expect(accounts.every((a) => a.system && a.balance === "0.00")).toBe(true);
    // A second read doesn't add them again.
    expect((await ok<{ accounts: Account[] }>(await get(token, "/accounts"))).accounts).toHaveLength(26);
  });

  it("added accounts: renamed, codes unique, built-in ones untouchable, removed only while unused", async () => {
    const { token } = await ownerSession();
    const { account } = await ok(await post(token, "/accounts", { code: "1600", name: "سيارات", type: "asset" }), 201);
    expect(account).toMatchObject({ code: "1600", name: "سيارات", type: "asset", system: false, used: false });

    for (const code of ["1600", "1010"]) {
      const dup = await post(token, "/accounts", { code, name: "تاني", type: "asset" });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("ACCOUNT_CODE_USED");
    }
    expect((await post(token, "/accounts", { code: "x1", name: "x", type: "asset" })).status).toBe(400);

    const renamed = await api().patch(`/api/ledger/accounts/${account.id}`).set(auth(token)).send({ code: "1610", name: "سيارات الشركة" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.account).toMatchObject({ code: "1610", name: "سيارات الشركة" });

    const bank = (await chart(token)).bank!;
    const sys = await api().patch(`/api/ledger/accounts/${bank.id}`).set(auth(token)).send({ code: "1021", name: "x" });
    expect(sys.body.error.code).toBe("SYSTEM_ACCOUNT");
    expect((await api().delete(`/api/ledger/accounts/${bank.id}`).set(auth(token))).body.error.code).toBe("SYSTEM_ACCOUNT");

    const entry = await manual(token, [
      { accountId: account.id, debit: "200000" },
      { accountId: bank.id, credit: "200000" },
    ]);
    const inUse = await api().delete(`/api/ledger/accounts/${account.id}`).set(auth(token));
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("ACCOUNT_IN_USE");

    expect((await api().delete(`/api/ledger/entries/${entry.id}`).set(auth(token))).status).toBe(204);
    expect((await api().delete(`/api/ledger/accounts/${account.id}`).set(auth(token))).status).toBe(204);
    expect((await chart(token))["1610"]).toBeUndefined();
  });
});

describe("automatic entries", () => {
  it("an issued invoice: customers debit, sales and VAT credit; drafts and cancelled ones make none", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const issued = await invoice(token, customer.id);
    await invoice(token, customer.id, { send: false, price: "500" });
    const cancelled = await invoice(token, customer.id, { price: "700" });
    await ok(await api().post(`/api/invoices/${cancelled.id}/cancel`).set(auth(token)));

    expect(await balances(token)).toEqual({ customers: "1140.00", sales: "1000.00", vat: "140.00" });
    const { items } = await entries(token, "&source=invoice");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "invoice", id: issued.id, ref: issued.displayNumber, party: "شركة النيل", amount: "1140.00" });
    expect(linesOf(items[0]!)).toEqual(["customers 1140.00/0.00", "sales 0.00/1000.00", "vat 0.00/140.00"]);
  });

  it("payments go where they were received; a cheque waits in cheques until it clears", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const inv = await invoice(token, customer.id, { price: "10000" }); // 11400 with VAT

    const cash = await pay(token, inv.id, { amount: "1000", method: "cash" });
    await pay(token, inv.id, { amount: "500", method: "vodafoneCash" });
    await pay(token, inv.id, { amount: "700", method: "instapay" });
    await pay(token, inv.id, { amount: "300", method: "bank", account: "cashbox" });
    const cheque = await pay(token, inv.id, { amount: "2000", method: "cheque" });

    expect(await balances(token)).toMatchObject({
      cashbox: "1300.00",
      wallet: "500.00",
      bank: "700.00",
      cheques: "2000.00",
      customers: "6900.00",
    });

    await ok(await api().post(`/api/payments/${cheque.id}/clear`).set(auth(token)));
    const afterClear = await balances(token);
    expect(afterClear.bank).toBe("2700.00");
    expect(afterClear.cheques).toBeUndefined();
    const { items } = await entries(token, "&source=payment");
    expect(items.map((e) => e.source).sort()).toEqual(["chequeCleared", "payment", "payment", "payment", "payment", "payment"]);
    const cleared = items.find((e) => e.source === "chequeCleared")!;
    expect(linesOf(cleared)).toEqual(["bank 2000.00/0.00", "cheques 0.00/2000.00"]);
    expect(cleared.ref).toMatch(/^PAY-\d{4}$/);

    expect((await api().delete(`/api/payments/${cash.id}`).set(auth(token))).status).toBe(204);
    expect(await balances(token)).toMatchObject({ cashbox: "300.00", customers: "7900.00" });
  });

  it("expenses: from where they were paid, or owed to suppliers until paid", async () => {
    const { token } = await ownerSession();
    await expense(token, { category: "rent", amount: "3000", paidFrom: "bank" });
    await expense(token, { category: "software", amount: "500", paidFrom: "card" });
    await expense(token, { category: "salaries", amount: "2000", paidFrom: "cash" });
    const due = await expense(token, { category: "purchases", amount: "1200", status: "due", paidFrom: null, date: lastMonthDay() });

    expect(await balances(token)).toEqual({
      bank: "-3500.00",
      cashbox: "-2000.00",
      suppliers: "1200.00",
      purchases: "1200.00",
      salaries: "2000.00",
      rent: "3000.00",
      software: "500.00",
    });

    await ok(await api().post(`/api/expenses/${due.id}/pay`).set(auth(token)).send({ paidFrom: "cash" }));
    const after = await balances(token);
    expect(after.suppliers).toBeUndefined();
    expect(after.cashbox).toBe("-3200.00");
    const { items } = await entries(token, "&source=expense");
    expect(items).toHaveLength(5);
    const payment = items.find((e) => e.source === "expensePayment")!;
    expect(payment).toMatchObject({ date: today(), memo: "مصروف" });
    expect(linesOf(payment)).toEqual(["suppliers 1200.00/0.00", "cashbox 0.00/1200.00"]);

    // Saved as due and paid the same day: one entry, straight from the cash box.
    const sameDay = await expense(token, { category: "utilities", amount: "90", status: "due", paidFrom: null });
    await ok(await api().post(`/api/expenses/${sameDay.id}/pay`).set(auth(token)).send({ paidFrom: "cash" }));
    const utilities = (await entries(token, "&q=" + encodeURIComponent("مصروف"))).items.filter((e) => e.id === sameDay.id);
    expect(utilities.map(linesOf)).toEqual([["utilities 90.00/0.00", "cashbox 0.00/90.00"]]);

    expect((await api().delete(`/api/expenses/${due.id}`).set(auth(token))).status).toBe(204);
    expect((await entries(token, "&source=expense")).items).toHaveLength(4);
  });

  it("the trial balance always balances and matches the journal", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const inv = await invoice(token, customer.id, { price: "2500", issueDate: lastMonthDay() });
    await pay(token, inv.id, { amount: "1000", method: "cheque", date: lastMonthDay() });
    await expense(token, { category: "marketing", amount: "800", status: "due", paidFrom: null, date: lastMonthDay() });
    const accounts = await chart(token);
    await manual(token, [
      { accountId: accounts.bank!.id, debit: "50000" },
      { accountId: accounts.capital!.id, credit: "50000" },
    ]);

    const all = await ok(await get(token, "/trial-balance?month=all"));
    expect(all.balanced).toBe(true);
    expect(all.totalDebit).toBe(all.totalCredit);
    expect(all.months).toEqual([thisMonth(), lastMonth()]);

    // Last month only: the invoice, the cheque and the expense.
    const last = await ok(await get(token, `/trial-balance?month=${lastMonth()}`));
    expect(last.balanced).toBe(true);
    expect(last.rows.map((r: { account: { key: string }; debit: string; credit: string }) => `${r.account.key} ${r.debit}/${r.credit}`)).toEqual([
      "cheques 1000.00/0.00",
      "customers 1850.00/0.00",
      "suppliers 0.00/800.00",
      "vat 0.00/350.00",
      "sales 0.00/2500.00",
      "marketing 800.00/0.00",
    ]);

    // Every entry balances, and the journal adds up to the trial balance.
    const { items } = await entries(token);
    let debit = 0;
    for (const e of items) {
      const d = e.lines.reduce((s, l) => s + Number(l.debit), 0);
      const c = e.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(d).toBeCloseTo(c, 2);
      expect(d).toBeCloseTo(Number(e.amount), 2);
      debit += d;
    }
    expect(items).toHaveLength(4);
    expect(debit).toBeCloseTo(2850 + 1000 + 800 + 50000, 2);
  });
});

describe("manual entries", () => {
  it("a posted entry counts in the balances; a draft only once it is posted", async () => {
    const { token } = await ownerSession();
    const accounts = await chart(token);
    const capital = await manual(token, [
      { accountId: accounts.bank!.id, debit: "50,000" },
      { accountId: accounts.capital!.id, credit: "50000" },
    ], { memo: "رأس المال" });
    expect(capital).toMatchObject({ source: "manual", ref: "JE-0001", status: "posted", memo: "رأس المال", amount: "50000.00" });
    expect(linesOf(capital)).toEqual(["bank 50000.00/0.00", "capital 0.00/50000.00"]);
    expect(await balances(token)).toEqual({ bank: "50000.00", capital: "50000.00" });

    const draft = await manual(token, [
      { accountId: accounts.drawings!.id, debit: "1000" },
      { accountId: accounts.cashbox!.id, credit: "1000" },
    ], { status: "draft" });
    expect(draft).toMatchObject({ ref: "JE-0002", status: "draft" });
    expect(await balances(token)).toEqual({ bank: "50000.00", capital: "50000.00" });
    expect((await ok(await get(token, `/trial-balance?month=${thisMonth()}`))).drafts).toBe(1);

    const posted = await ok(await post(token, `/entries/${draft.id}/post`));
    expect(posted.entry.status).toBe("posted");
    // Drawings lower the owner's equity: a debit shows as a negative balance there.
    expect(await balances(token)).toMatchObject({ drawings: "-1000.00", cashbox: "-1000.00" });
    expect((await post(token, `/entries/${draft.id}/post`)).body.error.code).toBe("ENTRY_NOT_DRAFT");
  });

  it("must balance, use this company's accounts, and have one side on each line", async () => {
    const { token } = await ownerSession();
    const other = await ownerSession();
    const mine = await chart(token);
    const theirs = await chart(other.token);
    const send = (lines: unknown[]) => post(token, "/entries", { date: today(), memo: "x", lines });

    const unbalanced = await send([
      { accountId: mine.bank!.id, debit: "100" },
      { accountId: mine.capital!.id, credit: "90" },
    ]);
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error).toMatchObject({ code: "ENTRY_NOT_BALANCED", details: { debit: "100.00", credit: "90.00" } });

    expect((await send([{ accountId: mine.bank!.id, debit: "100" }])).status).toBe(400);
    expect((await send([
      { accountId: mine.bank!.id, debit: "100", credit: "100" },
      { accountId: mine.capital!.id, credit: "100" },
    ])).status).toBe(400);
    expect((await send([
      { accountId: mine.bank!.id, debit: "0", credit: "" },
      { accountId: mine.capital!.id, credit: "100" },
    ])).status).toBe(400);

    const foreign = await send([
      { accountId: theirs.bank!.id, debit: "100" },
      { accountId: mine.capital!.id, credit: "100" },
    ]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("INVALID_ACCOUNT");
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("can be edited and deleted", async () => {
    const { token } = await ownerSession();
    const a = await chart(token);
    const entry = await manual(token, [
      { accountId: a.bank!.id, debit: "100" },
      { accountId: a.capital!.id, credit: "100" },
    ]);
    const edited = await api()
      .patch(`/api/ledger/entries/${entry.id}`)
      .set(auth(token))
      .send({
        date: today(),
        memo: "قرض",
        lines: [
          { accountId: a.bank!.id, debit: "300" },
          { accountId: a.loans!.id, credit: "300" },
        ],
      });
    expect(edited.status).toBe(200);
    expect(edited.body.entry).toMatchObject({ ref: "JE-0001", memo: "قرض", amount: "300.00" });
    expect(await balances(token)).toEqual({ bank: "300.00", loans: "300.00" });

    expect((await api().delete(`/api/ledger/entries/${entry.id}`).set(auth(token))).status).toBe(204);
    expect((await get(token, `/entries/${entry.id}`)).status).toBe(404);
    expect(await balances(token)).toEqual({});
  });
});

describe("the journal", () => {
  it("lists every entry newest first, with filters, search and pages", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token, "مؤسسة النور");
    const inv = await invoice(token, customer.id);
    await pay(token, inv.id, { amount: "100" });
    await expense(token, { title: "إيجار المكتب" });
    const a = await chart(token);
    await manual(token, [
      { accountId: a.bank!.id, debit: "10" },
      { accountId: a.capital!.id, credit: "10" },
    ], { date: lastMonthDay(), status: "draft" });

    const all = await entries(token);
    expect(all.total).toBe(4);
    expect(all.items.at(-1)).toMatchObject({ source: "manual", status: "draft", date: lastMonthDay() });
    const dates = all.items.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());

    expect((await entries(token, "&source=manual")).total).toBe(1);
    expect((await entries(token, "&source=payment")).total).toBe(1);
    expect((await entries(token, "&status=draft")).total).toBe(1);
    expect((await entries(token, "&status=posted")).total).toBe(3);
    expect((await entries(token, `&month=${lastMonth()}`)).total).toBe(1);
    // The payment's text includes its invoice and customer.
    expect((await entries(token, `&q=${encodeURIComponent(inv.displayNumber)}`)).total).toBe(2);
    expect((await entries(token, `&q=${encodeURIComponent("النور")}`)).total).toBe(2);
    expect((await entries(token, `&q=${encodeURIComponent("إيجار")}`)).total).toBe(1);
    expect((await entries(token, "&q=JE-0001")).total).toBe(1);
    expect((await entries(token, "&q=%25")).total).toBe(0);

    const page2 = await ok(await get(token, "/entries?pageSize=3&page=2"));
    expect(page2).toMatchObject({ total: 4, page: 2 });
    expect(page2.items).toHaveLength(1);
  });
});

describe("bounced cheques", () => {
  it("owed again, reversed in the books today, even when its month is closed", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const day = lastMonthDay();
    const inv = await invoice(token, customer.id, { issueDate: day }); // 1140
    const cheque = await pay(token, inv.id, { amount: "1140", method: "cheque", date: day });
    const cash = await pay(token, (await invoice(token, customer.id)).id, { amount: "100" });
    const lastMonthBefore = await ok(await get(token, `/trial-balance?month=${lastMonth()}`));
    await ok(await post(token, "/periods/close", { month: lastMonth() }));

    const bounced = await api().post(`/api/payments/${cheque.id}/bounce`).set(auth(token));
    expect(bounced.status).toBe(200);
    expect(bounced.body.payment).toMatchObject({ status: "bounced" });
    expect(bounced.body.payment.bouncedAt).not.toBeNull();

    // Owed again.
    const after = (await ok(await api().get(`/api/invoices/${inv.id}`).set(auth(token)))).invoice;
    // Unpaid again (overdue by now: it was issued last month).
    expect(after.remaining).toBe("1140.00");
    expect(["sent", "overdue"]).toContain(after.status);
    expect(after.history.some((e: { type: string }) => e.type === "chequeBounced")).toBe(true);
    const owed = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id }, select: { balance: true } });
    expect(owed.balance.toFixed(2)).toBe("2180.00"); // 1140 + (1140 - 100)

    // The closed month is untouched; the reversal is today.
    expect((await ok(await get(token, `/trial-balance?month=${lastMonth()}`))).rows).toEqual(lastMonthBefore.rows);
    const { items } = await entries(token, "&source=payment");
    const reversal = items.find((e) => e.source === "chequeBounced")!;
    expect(reversal).toMatchObject({ date: today(), amount: "1140.00" });
    expect(linesOf(reversal)).toEqual(["customers 1140.00/0.00", "cheques 0.00/1140.00"]);
    const now = await balances(token);
    expect(now.cheques).toBeUndefined();
    expect(now.customers).toBe("2180.00");

    // It stays on record; nothing else can bounce.
    expect((await api().delete(`/api/payments/${cheque.id}`).set(auth(token))).body.error.code).toBe("PAYMENT_BOUNCED");
    expect((await api().post(`/api/payments/${cheque.id}/bounce`).set(auth(token))).body.error.code).toBe("PAYMENT_NOT_PENDING");
    expect((await api().post(`/api/payments/${cash.id}/bounce`).set(auth(token))).body.error.code).toBe("PAYMENT_NOT_PENDING");

    // The customer's statement leaves it out; the audit log has it.
    const statement = (await ok(await api().get(`/api/reports/statement?customerId=${customer.id}&period=${lastMonth()}`).set(auth(token)))).statement;
    expect(statement.txns.map((t: { type: string }) => t.type)).toEqual(["invoice"]);
    const audit = (await ok(await api().get("/api/audit?action=payment").set(auth(token)))).items;
    expect(audit[0]).toMatchObject({ event: "chequeBounced", values: { amount: "1140.00" } });
  });
});

describe("journal edge cases", () => {
  it("a free invoice isn't an entry; numbers past 9999 keep every digit in the search", async () => {
    const { token, companyId } = await ownerSession();
    const customer = await customerOf(token);
    await invoice(token, customer.id, { price: "0" });
    expect((await entries(token, "&source=invoice")).total).toBe(0);

    await prisma.company.update({ where: { id: companyId }, data: { paymentNextNumber: 12345 } });
    const inv = await invoice(token, customer.id);
    await pay(token, inv.id, { amount: "100" });
    expect((await entries(token, "&q=PAY-12345")).total).toBe(1);
    expect((await entries(token, "&q=PAY-1234&source=payment")).items[0]!.ref).toBe("PAY-12345");
  });
});

describe("closing periods", () => {
  it("warns about cheques still pending in what would close", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const inv = await invoice(token, customer.id, { issueDate: lastMonthDay() });
    await pay(token, inv.id, { amount: "500", method: "cheque", date: lastMonthDay() });
    await pay(token, inv.id, { amount: "100", method: "cheque" });
    expect(await ok(await get(token, "/periods"))).toMatchObject({ toClose: lastMonth(), pendingCheques: 1 });
  });

  it("only a month that has ended, and not while it has drafts", async () => {
    const { token } = await ownerSession();
    const fresh = await ok(await get(token, "/periods"));
    expect(fresh).toMatchObject({ closedThrough: null, toClose: null, open: [{ month: thisMonth(), ended: false, drafts: 0 }] });

    expect((await post(token, "/periods/close", { month: thisMonth() })).body.error.code).toBe("PERIOD_NOT_ENDED");

    const a = await chart(token);
    await manual(token, [
      { accountId: a.bank!.id, debit: "10" },
      { accountId: a.capital!.id, credit: "10" },
    ], { date: lastMonthDay(), status: "draft" });
    const periods = await ok(await get(token, "/periods"));
    expect(periods.toClose).toBe(lastMonth());
    expect(periods.open).toEqual([
      { month: thisMonth(), ended: false, drafts: 0 },
      { month: lastMonth(), ended: true, drafts: 1 },
    ]);

    const blocked = await post(token, "/periods/close", { month: lastMonth() });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "PERIOD_HAS_DRAFTS", details: { drafts: 1 } });
    expect((await ok(await get(token, "/periods"))).closedThrough).toBeNull();

    expect(await ok(await post(token, "/entries/post-drafts", { month: lastMonth() }))).toEqual({ posted: 1 });
    const closed = await ok(await post(token, "/periods/close", { month: lastMonth() }));
    expect(closed).toMatchObject({
      closedThrough: monthRange(today(), -1).end,
      toClose: null,
      open: [{ month: thisMonth(), ended: false, drafts: 0 }],
    });
    expect(closed.closedAt).not.toBeNull();
    expect((await post(token, "/periods/close", { month: lastMonth() })).body.error.code).toBe("PERIOD_ALREADY_CLOSED");
  });

  it("nothing dated in a closed month can be added, changed or removed", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const day = lastMonthDay();
    const unpaid = await invoice(token, customer.id, { issueDate: day });
    const paid = await invoice(token, customer.id, { issueDate: day });
    const payment = await pay(token, paid.id, { amount: "100", date: day });
    const draft = await invoice(token, customer.id, { issueDate: day, send: false });
    const spent = await expense(token, { date: day });
    const a = await chart(token);
    const entry = await manual(token, [
      { accountId: a.bank!.id, debit: "10" },
      { accountId: a.capital!.id, credit: "10" },
    ], { date: day });
    const before = await ok(await get(token, `/trial-balance?month=${lastMonth()}`));

    await ok(await post(token, "/periods/close", { month: lastMonth() }));

    const refused = async (res: { status: number; body: any }) => {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: "PERIOD_CLOSED", details: { closedThrough: monthRange(today(), -1).end } });
    };
    await refused(await expenseRequest(token, { date: day }));
    await refused(
      await api().post("/api/invoices").set(auth(token)).send({
        customerId: customer.id,
        issueDate: day,
        terms: 30,
        send: true,
        items: [{ description: "x", quantity: "1", unitPrice: "1" }],
      }),
    );
    await refused(await api().post(`/api/invoices/${draft.id}/send`).set(auth(token)));
    await refused(await api().post(`/api/invoices/${unpaid.id}/cancel`).set(auth(token)));
    await refused(await payRequest(token, unpaid.id, { amount: "50", date: day }));
    await refused(await api().delete(`/api/payments/${payment.id}`).set(auth(token)));
    await refused(await api().delete(`/api/expenses/${spent.id}`).set(auth(token)));
    await refused(await post(token, "/entries", { date: day, memo: "x", lines: [
      { accountId: a.bank!.id, debit: "1" },
      { accountId: a.capital!.id, credit: "1" },
    ] }));
    await refused(await api().patch(`/api/ledger/entries/${entry.id}`).set(auth(token)).send({
      date: today(),
      memo: "moved out",
      lines: [
        { accountId: a.bank!.id, debit: "10" },
        { accountId: a.capital!.id, credit: "10" },
      ],
    }));
    await refused(await api().delete(`/api/ledger/entries/${entry.id}`).set(auth(token)));

    // Still allowed: drafts (not in the books yet), and anything dated in an open month.
    await invoice(token, customer.id, { issueDate: day, send: false });
    await pay(token, unpaid.id, { amount: "50" });
    await expense(token, {});

    // The closed month's books are exactly as they were when it closed.
    const after = await ok(await get(token, `/trial-balance?month=${lastMonth()}`));
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.map((r: { account: { key: string }; debit: string; credit: string }) => `${r.account.key} ${r.debit}/${r.credit}`)).toEqual([
      "cashbox 100.00/0.00",
      "bank 0.00/990.00",
      "customers 2180.00/0.00",
      "vat 0.00/280.00",
      "capital 0.00/10.00",
      "sales 0.00/2000.00",
      "rent 1000.00/0.00",
    ]);
  });

  it("the owner can open the last closed month again", async () => {
    const { token } = await ownerSession();
    const accountant = await teamMember(token, "accountant");
    await ok(await post(accountant.token, "/periods/close", { month: lastMonth() }));
    expect((await expenseRequest(token, { date: lastMonthDay() })).status).toBe(409);

    expect((await post(accountant.token, "/periods/reopen")).status).toBe(403);
    const reopened = await ok(await post(token, "/periods/reopen"));
    expect(reopened.closedThrough).toBe(monthRange(today(), -2).end);
    expect((await expenseRequest(token, { date: lastMonthDay() })).status).toBe(201);
  });
});

describe("access", () => {
  it("sales and viewers can't see the books; accountants can use them", async () => {
    const { token } = await ownerSession();
    const sales = await teamMember(token, "sales");
    const viewer = await teamMember(token, "viewer");
    const accountant = await teamMember(token, "accountant");

    expect((await get(sales.token, "/accounts")).status).toBe(403);
    expect((await get(viewer.token, "/entries")).status).toBe(403);
    expect((await get(viewer.token, "/trial-balance")).status).toBe(403);

    const a = await chart(accountant.token);
    const entry = await manual(accountant.token, [
      { accountId: a.cashbox!.id, debit: "500" },
      { accountId: a.capital!.id, credit: "500" },
    ]);
    expect(entry.ref).toBe("JE-0001");
  });

  it("a company with manual entries and added accounts can still be deleted whole", async () => {
    const { token, companyId } = await ownerSession();
    const { account } = await ok(await post(token, "/accounts", { code: "1600", name: "سيارات", type: "asset" }), 201);
    const a = await chart(token);
    await manual(token, [
      { accountId: account.id, debit: "100" },
      { accountId: a.capital!.id, credit: "100" },
    ]);
    await prisma.company.delete({ where: { id: companyId } });
    expect(await prisma.journalLine.count()).toBe(0);
    expect(await prisma.ledgerAccount.count()).toBe(0);
  });

  it("a company sees only its own books", async () => {
    const one = await ownerSession();
    const two = await ownerSession();
    const customer = await customerOf(one.token);
    await invoice(one.token, customer.id);
    const a = await chart(one.token);
    const entry = await manual(one.token, [
      { accountId: a.bank!.id, debit: "10" },
      { accountId: a.capital!.id, credit: "10" },
    ]);

    expect((await entries(two.token)).total).toBe(0);
    expect(await balances(two.token)).toEqual({});
    expect((await get(two.token, `/entries/${entry.id}`)).status).toBe(404);
    expect((await api().delete(`/api/ledger/entries/${entry.id}`).set(auth(two.token))).status).toBe(404);
    expect((await api().delete(`/api/ledger/accounts/${a.bank!.id}`).set(auth(two.token))).status).toBe(404);
    expect((await ok(await get(two.token, "/periods"))).open).toHaveLength(1);
  });
});
