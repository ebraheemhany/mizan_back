import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange } from "../src/lib/dates.js";
import { runDueRecurring } from "../src/modules/recurring/recurring.service.js";
import { api, auth, login, ownerSession, PASSWORD, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

type Line = {
  id: string;
  at: string;
  action: string;
  event: string;
  item: { type: string; id: string | null; ref: string | null };
  values: Record<string, unknown>;
  ip: string | null;
  user: { id: string | null; name: string | null } | null;
};

async function ok(res: { status: number; body: any }, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const send = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(path).set(auth(token)).send(body);

async function log(token: string, query = "") {
  return ok(await api().get(`/api/audit?pageSize=100${query}`).set(auth(token))) as Promise<{
    items: Line[];
    total: number;
    users: { id: string; name: string }[];
  }>;
}
const events = async (token: string, query = "") => (await log(token, query)).items.map((l) => l.event);

describe("what gets recorded", () => {
  it("sign-in, customers, invoices, payments and expenses, with who, what and the IP", async () => {
    const owner = await ownerSession();
    const { token } = owner;
    const customer = (await ok(await send(token, "/api/customers", { name: "شركة النيل", city: "القاهرة" }), 201)).customer;
    await ok(await api().patch(`/api/customers/${customer.id}`).set(auth(token)).send({ phone: "01000000001", city: "القاهرة" }));
    const invoice = (await ok(await send(token, "/api/invoices", {
      customerId: customer.id,
      issueDate: today(),
      terms: 30,
      send: true,
      items: [{ description: "خدمة", quantity: "1", unitPrice: "1000" }],
    }), 201)).invoice;
    await ok(await send(token, "/api/payments", { invoiceId: invoice.id, amount: "500", date: today(), method: "cash" }), 201);
    const expense = (await ok(await send(token, "/api/expenses", {
      title: "إيجار",
      category: "rent",
      amount: "3000",
      date: today(),
      status: "paid",
      paidFrom: "bank",
    }), 201)).expense;
    expect((await api().delete(`/api/expenses/${expense.id}`).set(auth(token))).status).toBe(204);

    const { items, users } = await log(token);
    // Newest first.
    expect(items.map((l) => l.event)).toEqual([
      "expenseDeleted",
      "expenseAdded",
      "paymentRecorded",
      "invoiceIssued",
      "customerUpdated",
      "customerCreated",
      "signedIn",
      "companyCreated",
    ]);
    const byEvent = Object.fromEntries(items.map((l) => [l.event, l]));
    expect(byEvent.invoiceIssued).toMatchObject({
      action: "create",
      item: { type: "invoice", id: invoice.id, ref: invoice.displayNumber },
      values: { number: invoice.number, amount: "1140.00", customer: "شركة النيل" },
      user: { id: owner.userId, name: "محمد أحمد" },
    });
    expect(byEvent.paymentRecorded).toMatchObject({ action: "payment", values: { amount: "500.00", method: "cash" } });
    expect(byEvent.paymentRecorded!.values.payment).toMatch(/^PAY-\d{4}$/);
    // Only the fields that really changed (the city was sent unchanged).
    expect(byEvent.customerUpdated).toMatchObject({ action: "update", values: { fields: ["phone"] } });
    expect(byEvent.expenseDeleted).toMatchObject({ action: "delete", item: { type: "expense", id: null, ref: "إيجار" } });
    expect(byEvent.signedIn).toMatchObject({ action: "login", item: { type: "account", ref: owner.email } });
    expect(byEvent.signedIn!.ip).toMatch(/127\.0\.0\.1|::1/);
    expect(users).toEqual([{ id: owner.userId, name: "محمد أحمد" }]);
  });

  it("a change that is refused or rolled back leaves no line", async () => {
    const { token } = await ownerSession();
    const customer = (await ok(await send(token, "/api/customers", { name: "شركة النيل" }), 201)).customer;
    await ok(await send(token, "/api/invoices", {
      customerId: customer.id,
      issueDate: today(),
      terms: 30,
      send: true,
      items: [{ description: "خدمة", quantity: "1", unitPrice: "1000" }],
    }), 201);
    const before = (await log(token)).total;

    // A customer with invoices can't be deleted (the database refuses, in the same transaction).
    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(token))).status).toBe(409);
    // An expense in a closed month.
    await ok(await send(token, "/api/ledger/periods/close", { month: monthRange(today(), -1).start.slice(0, 7) }));
    expect((await send(token, "/api/expenses", {
      title: "x",
      category: "rent",
      amount: "1",
      date: addDays(monthRange(today(), -1).start, 3),
      status: "paid",
      paidFrom: "bank",
    })).status).toBe(409);

    const after = await events(token);
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toBe("periodClosed");
  });

  it("the team: invites, joining, role changes, removal (the name stays on old lines)", async () => {
    const { token } = await ownerSession();
    const member = await teamMember(token, "sales");
    await ok(await api().patch(`/api/users/${member.userId}`).set(auth(token)).send({ role: "accountant" }));
    await ok(await send(member.token, "/api/expenses", {
      title: "قهوة",
      category: "utilities",
      amount: "50",
      date: today(),
      status: "paid",
      paidFrom: "cash",
    }), 201);
    expect((await api().delete(`/api/users/${member.userId}`).set(auth(token))).status).toBe(204);

    const { items } = await log(token);
    const byEvent = Object.fromEntries(items.map((l) => [l.event, l]));
    expect(byEvent.userInvited).toMatchObject({ action: "permissions", item: { ref: "Sara Ali" }, values: { role: "sales" } });
    // Removed since: the link to the user is gone, the name stays.
    expect(byEvent.memberJoined).toMatchObject({ user: { id: null, name: "Sara Ali" }, values: { role: "sales" } });
    expect(byEvent.roleChanged).toMatchObject({ values: { from: "sales", role: "accountant" } });
    expect(byEvent.memberRemoved).toMatchObject({ item: { ref: "Sara Ali" } });
    // The member's own action keeps their name after they were removed.
    expect(byEvent.expenseAdded!.user).toEqual({ id: null, name: "Sara Ali" });
  });

  it("a wrong password for a real account is logged there; an unknown email nowhere", async () => {
    const owner = await ownerSession();
    expect((await api().post("/api/auth/login").send({ email: owner.email, password: "Wrong-pass1" })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "nobody@example.com", password: "Wrong-pass1" })).status).toBe(401);
    await login(owner.email, PASSWORD);

    const { items } = await log(owner.token, "&action=login");
    expect(items.map((l) => l.event)).toEqual(["signedIn", "signInFailed", "signedIn"]);
    expect(await prisma.auditEvent.count()).toBe(4); // + companyCreated
  });

  it("the system and customers: a recurring invoice, a quote answered from its link", async () => {
    const { token } = await ownerSession();
    const customer = (await ok(await send(token, "/api/customers", { name: "شركة الأفق" }), 201)).customer;
    await ok(await send(token, "/api/recurring", {
      name: "دعم شهري",
      customerId: customer.id,
      frequency: "monthly",
      // Starting today: the first invoice is made right away, by the system.
      startDate: today(),
      endMode: "never",
      endDate: null,
      occurrences: null,
      terms: 15,
      autoSend: true,
      items: [{ description: "دعم", quantity: "1", unitPrice: "1000" }],
      notes: "",
    }), 201);
    // The hourly job finds nothing more to make today.
    await runDueRecurring(today());

    const quote = (await ok(await send(token, "/api/quotes", {
      customerId: customer.id,
      issueDate: today(),
      validUntil: addDays(today(), 30),
      items: [{ description: "عرض", quantity: "1", unitPrice: "500" }],
      send: true,
    }), 201)).quote;
    await ok(await api().post(`/api/public/quotes/${quote.publicToken}/accept`).send({}));

    const { items } = await log(token);
    const made = items.find((l) => l.event === "invoiceMadeRecurring")!;
    expect(made.user).toBeNull();
    expect(made.ip).toBeNull();
    expect(items.find((l) => l.event === "quoteAcceptedByCustomer")).toMatchObject({
      user: { id: null, name: "شركة الأفق" },
      values: { viaLink: true },
    });
    expect(items.find((l) => l.event === "quoteCreatedSent")).toBeTruthy();
    // "system": what nobody signed in did (the job, a customer from a link).
    expect((await log(token, "&userId=system")).items.map((l) => l.event)).toEqual([
      "quoteAcceptedByCustomer",
      "invoiceMadeRecurring",
    ]);
  });

  it("settings and the books", async () => {
    const { token } = await ownerSession();
    await ok(
      await api()
        .patch("/api/settings")
        .set(auth(token))
        .send({ company: { name: "شركة ميزان الجديدة", taxNumber: "", commercialRegister: "", phone: "", address: "" } }),
    );
    const { accounts } = await ok(await api().get("/api/ledger/accounts").set(auth(token)));
    const id = Object.fromEntries(accounts.map((a: { key: string; id: string }) => [a.key, a.id]));
    const entry = (await ok(await send(token, "/api/ledger/entries", {
      date: today(),
      memo: "رأس المال",
      status: "draft",
      lines: [{ accountId: id.bank, debit: "1000" }, { accountId: id.capital, credit: "1000" }],
    }), 201)).entry;
    await ok(await send(token, `/api/ledger/entries/${entry.id}/post`));

    const { items } = await log(token);
    expect(items.slice(0, 3).map((l) => l.event)).toEqual(["entryPostedLater", "entryDrafted", "settingsUpdated"]);
    expect(items[1]).toMatchObject({ item: { type: "entry", ref: "JE-0001" }, values: { amount: "1000.00", memo: "رأس المال" } });
    expect(items[2]).toMatchObject({ action: "settings", item: { ref: "شركة ميزان الجديدة" }, values: { sections: ["company"] } });
  });
});

describe("reading the log", () => {
  it("filters by action, user and text, in pages, and exports", async () => {
    const { token, userId } = await ownerSession();
    for (const name of ["أ", "ب", "ج"]) await ok(await send(token, "/api/customers", { name: `عميل ${name}` }), 201);

    expect((await log(token, "&action=create")).total).toBe(4);
    expect((await log(token, `&userId=${userId}`)).total).toBe(5);
    expect((await log(token, `&q=${encodeURIComponent("عميل ب")}`)).items.map((l) => l.item.ref)).toEqual(["عميل ب"]);
    const page = await ok(await api().get("/api/audit?pageSize=2&page=2").set(auth(token)));
    expect(page).toMatchObject({ total: 5, page: 2 });
    expect(page.items).toHaveLength(2);
    const exported = await ok(await api().get("/api/audit/export?action=create").set(auth(token)));
    expect(exported.items).toHaveLength(4);
    expect(exported.limited).toBe(false);

    expect((await api().get("/api/audit?period=d1").set(auth(token))).status).toBe(400);
  });

  it("is for the owner only, and only their company's", async () => {
    const one = await ownerSession();
    const two = await ownerSession();
    const accountant = await teamMember(one.token, "accountant");
    expect((await api().get("/api/audit").set(auth(accountant.token))).status).toBe(403);
    await ok(await send(one.token, "/api/customers", { name: "عميل" }), 201);
    expect((await log(two.token)).items.map((l) => l.event)).toEqual(["signedIn", "companyCreated"]);
  });
});
