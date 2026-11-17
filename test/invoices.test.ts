import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function customerOf(token: string, body: Record<string, unknown> = {}) {
  const res = await api()
    .post("/api/customers")
    .set(auth(token))
    .send({ name: "شركة النيل", taxNumber: "412-558-903", email: "nile@example.com", city: "الجيزة", ...body });
  return res.body.customer as { id: string };
}

type Item = { description: string; quantity: string | number; unitPrice: string | number };
const oneItem: Item[] = [{ description: "تطوير موقع", quantity: "1", unitPrice: "1000" }];

async function createInvoice(
  token: string,
  customerId: string,
  { items = oneItem, send = true, issueDate = today(), terms = 30, notes }: { items?: Item[]; send?: boolean; issueDate?: string; terms?: number; notes?: string } = {},
) {
  const res = await api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate, terms, items, send, notes });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.invoice;
}

const pay = (token: string, ref: string | number, body: Record<string, unknown>) =>
  api().post(`/api/invoices/${ref}/payments`).set(auth(token)).send({ date: today(), method: "bank", ...body });

const balanceOf = async (customerId: string) =>
  (await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })).balance.toFixed(2);

describe("creating an invoice", () => {
  it("numbers invoices from the settings and works out the totals exactly", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);

    const invoice = await createInvoice(owner.token, customer.id, {
      items: [
        { description: "ساعات عمل", quantity: "3", unitPrice: "33.33" }, // 99.99
        { description: "كابل", quantity: "2.5", unitPrice: "10.01" }, // 25.025 -> 25.03
      ],
      issueDate: today(),
      terms: 15,
      notes: "شكراً",
    });

    expect(invoice).toMatchObject({
      number: 1,
      displayNumber: "INV-1",
      status: "sent",
      issueDate: today(),
      dueDate: addDays(today(), 15),
      terms: 15,
      subtotal: "125.02",
      vatRate: "14.00",
      vat: "17.50", // 125.02 x 14% = 17.5028
      total: "142.52",
      remaining: "142.52",
      note: "شكراً",
      customer: "شركة النيل",
      client: { name: "شركة النيل", taxNumber: "412-558-903", email: "nile@example.com", location: "الجيزة" },
    });
    expect(invoice.lines.map((l: { amount: string }) => l.amount)).toEqual(["99.99", "25.03"]);
    expect(invoice.publicToken).toMatch(/^[\w-]{43}$/);
    expect(invoice.history.map((h: { type: string }) => h.type)).toEqual(["sent", "created"]);

    const second = await createInvoice(owner.token, customer.id);
    expect(second.number).toBe(2);
  });

  it("follows the numbering and VAT settings", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const settings = (await api().get("/api/settings").set(auth(owner.token))).body.settings;
    await api()
      .patch("/api/settings")
      .set(auth(owner.token))
      .send({
        numbering: { ...settings.numbering, invoicePrefix: "F-", invoiceNext: 1044 },
        taxes: { ...settings.taxes, vatEnabled: false },
      });

    const invoice = await createInvoice(owner.token, customer.id);
    expect(invoice).toMatchObject({ number: 1044, displayNumber: "F-1044", vatRate: "0.00", vat: "0.00", total: "1000.00" });
    expect((await api().get("/api/settings").set(auth(owner.token))).body.settings.numbering.invoiceNext).toBe(1045);
  });

  it("never gives two invoices the same number, even at the same moment", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api().post("/api/invoices").set(auth(owner.token)).send({ customerId: customer.id, issueDate: today(), terms: 0, items: oneItem }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(results.map((r) => r.body.invoice.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps the customer's details as they were, even if the customer is edited later", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);
    await api().patch(`/api/customers/${customer.id}`).set(auth(owner.token)).send({ name: "اسم جديد" });

    const again = await api().get(`/api/invoices/${invoice.number}`).set(auth(owner.token));
    expect(again.body.invoice.client.name).toBe("شركة النيل");
  });

  it("validates the input", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirCustomer = await customerOf(other.token);
    const customer = await customerOf(owner.token);
    const post = (body: Record<string, unknown>) =>
      api().post("/api/invoices").set(auth(owner.token)).send({ customerId: customer.id, issueDate: today(), terms: 30, items: oneItem, ...body });

    expect((await post({ customerId: theirCustomer.id })).body.error.code).toBe("INVALID_CUSTOMER");
    for (const body of [
      { items: [] },
      { items: [{ description: "", quantity: "1", unitPrice: "1" }] },
      { items: [{ description: "x", quantity: "0", unitPrice: "1" }] },
      { items: [{ description: "x", quantity: "1", unitPrice: "-1" }] },
      { items: [{ description: "x", quantity: "1", unitPrice: "1.005" }] },
      { issueDate: "2026-02-30" },
      { terms: -1 },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await prisma.invoice.count()).toBe(0);
  });
});

describe("drafts and the customer's balance", () => {
  it("a draft owes nothing until it is sent", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const draft = await createInvoice(owner.token, customer.id, { send: false });

    expect(draft).toMatchObject({ status: "draft", remaining: "1140.00", publicToken: null });
    expect(await balanceOf(customer.id)).toBe("0.00");

    const sent = await api().post(`/api/invoices/${draft.id}/send`).set(auth(owner.token));
    expect(sent.status).toBe(200);
    expect(sent.body.invoice.status).toBe("sent");
    expect(sent.body.invoice.publicToken).toBeTruthy();
    expect(await balanceOf(customer.id)).toBe("1140.00");

    const again = await api().post(`/api/invoices/${draft.id}/send`).set(auth(owner.token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVOICE_NOT_DRAFT");
  });
});

describe("payments", () => {
  it("partial then full payment: status, remaining and the customer's balance follow", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id); // 1140.00

    const first = await pay(owner.token, invoice.number, { amount: "140.40", note: "تحويل 123" });
    expect(first.status).toBe(201);
    expect(first.body.invoice).toMatchObject({ status: "partial", remaining: "999.60" });
    expect(await balanceOf(customer.id)).toBe("999.60");

    const second = await pay(owner.token, invoice.number, { amount: "999.60", method: "cash" });
    expect(second.body.invoice).toMatchObject({ status: "paid", remaining: "0.00" });
    expect(second.body.invoice.payments.map((p: { amount: string }) => p.amount).sort()).toEqual(["140.40", "999.60"]);
    expect(await balanceOf(customer.id)).toBe("0.00");
  });

  it("refuses paying more than what is owed, a draft, a future date or a date before the invoice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id, { issueDate: addDays(today(), -10) });
    const draft = await createInvoice(owner.token, customer.id, { send: false });

    expect((await pay(owner.token, invoice.number, { amount: "1140.01" })).body.error.code).toBe("PAYMENT_EXCEEDS_BALANCE");
    expect((await pay(owner.token, draft.number, { amount: "10" })).body.error.code).toBe("INVOICE_NOT_PAYABLE");
    expect((await pay(owner.token, invoice.number, { amount: "10", date: addDays(today(), 1) })).body.error.code).toBe(
      "PAYMENT_DATE_IN_FUTURE",
    );
    expect((await pay(owner.token, invoice.number, { amount: "10", date: addDays(today(), -11) })).body.error.code).toBe(
      "PAYMENT_BEFORE_ISSUE",
    );
    expect((await pay(owner.token, invoice.number, { amount: "0" })).status).toBe(400);
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("two payments at the same moment can't together pay more than the total", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id); // 1140.00

    const results = await Promise.all([
      pay(owner.token, invoice.number, { amount: "700" }),
      pay(owner.token, invoice.number, { amount: "700" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.amountPaid.toFixed(2)).toBe("700.00");
    expect(await balanceOf(customer.id)).toBe("440.00");
  });
});

describe("overdue", () => {
  it("an unpaid invoice past its due date is overdue, and so is its customer", async () => {
    const owner = await ownerSession();
    const late = await customerOf(owner.token, { name: "متأخر" });
    const onTime = await customerOf(owner.token, { name: "منتظم" });
    const old = await createInvoice(owner.token, late.id, { issueDate: addDays(today(), -40), terms: 30 });
    await createInvoice(owner.token, onTime.id);

    const detail = await api().get(`/api/invoices/${old.number}`).set(auth(owner.token));
    expect(detail.body.invoice).toMatchObject({ status: "overdue", daysOverdue: 10 });

    const list = await api().get("/api/invoices?status=overdue").set(auth(owner.token));
    expect(list.body.items.map((i: { number: number }) => i.number)).toEqual([old.number]);
    expect(list.body.counts).toMatchObject({ all: 2, sent: 1, overdue: 1 });

    const customers = await api().get("/api/customers?status=overdue").set(auth(owner.token));
    expect(customers.body.items.map((c: { name: string }) => c.name)).toEqual(["متأخر"]);
    expect(customers.body.counts).toMatchObject({ overdue: 1, active: 1 });

    // Paying it off ends the overdue state.
    await pay(owner.token, old.number, { amount: "1140" });
    const paid = await api().get(`/api/invoices/${old.number}`).set(auth(owner.token));
    expect(paid.body.invoice).toMatchObject({ status: "paid", daysOverdue: null });
  });
});

describe("cancelling", () => {
  it("cancels a sent invoice with no payments and takes it off the customer's balance", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);

    const res = await api().post(`/api/invoices/${invoice.id}/cancel`).set(auth(owner.token));
    expect(res.body.invoice).toMatchObject({ status: "cancelled", remaining: "0.00" });
    expect(res.body.invoice.history[0].type).toBe("cancelled");
    expect(await balanceOf(customer.id)).toBe("0.00");

    expect((await api().post(`/api/invoices/${invoice.id}/cancel`).set(auth(owner.token))).status).toBe(409);
    expect((await pay(owner.token, invoice.number, { amount: "1" })).status).toBe(409);
  });

  it("refuses to cancel an invoice that has payments", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);
    await pay(owner.token, invoice.number, { amount: "100" });

    const res = await api().post(`/api/invoices/${invoice.id}/cancel`).set(auth(owner.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVOICE_NOT_CANCELLABLE");
  });

  it("bulk cancel skips the ones that can't be cancelled", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const a = await createInvoice(owner.token, customer.id);
    const b = await createInvoice(owner.token, customer.id, { send: false });
    const c = await createInvoice(owner.token, customer.id);
    await pay(owner.token, c.number, { amount: "1" });

    const res = await api().post("/api/invoices/bulk-cancel").set(auth(owner.token)).send({ ids: [a.id, b.id, c.id] });
    expect(res.body).toEqual({ cancelled: 2, skipped: 1 });
  });
});

describe("reminders", () => {
  it("records a reminder on an unpaid invoice only", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);
    const draft = await createInvoice(owner.token, customer.id, { send: false });
    const body = { channel: "whatsapp", recipient: "01000000000", message: "تذكير بالفاتورة" };

    const res = await api().post(`/api/invoices/${invoice.number}/reminders`).set(auth(owner.token)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.invoice.history[0]).toMatchObject({ type: "reminderSent", values: { channel: "whatsapp" } });

    expect((await api().post(`/api/invoices/${draft.number}/reminders`).set(auth(owner.token)).send(body)).status).toBe(409);
  });
});

describe("permissions by role", () => {
  it("everyone views; owner and accountant issue and record payments", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    for (const { token } of [owner, accountant, sales, viewer]) {
      expect((await api().get("/api/invoices").set(auth(token))).status).toBe(200);
      expect((await api().get(`/api/invoices/${invoice.number}`).set(auth(token))).status).toBe(200);
    }

    const newInvoice = (token: string) =>
      api().post("/api/invoices").set(auth(token)).send({ customerId: customer.id, issueDate: today(), terms: 30, items: oneItem });
    expect((await newInvoice(accountant.token)).status).toBe(201);
    expect((await newInvoice(sales.token)).status).toBe(403);
    expect((await newInvoice(viewer.token)).status).toBe(403);

    expect((await pay(accountant.token, invoice.number, { amount: "10" })).status).toBe(201);
    expect((await pay(sales.token, invoice.number, { amount: "10" })).status).toBe(403);
    expect((await api().post(`/api/invoices/${invoice.id}/cancel`).set(auth(viewer.token))).status).toBe(403);
  });
});

describe("company isolation", () => {
  it("another company's invoices can't be seen or touched, by id or by number", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirs = await createInvoice(other.token, (await customerOf(other.token)).id);
    // Both companies have an invoice number 1.
    await createInvoice(owner.token, (await customerOf(owner.token)).id);

    expect((await api().get(`/api/invoices/${theirs.id}`).set(auth(owner.token))).status).toBe(404);
    const byNumber = await api().get(`/api/invoices/${theirs.number}`).set(auth(owner.token));
    expect(byNumber.body.invoice.id).not.toBe(theirs.id);
    expect((await pay(owner.token, theirs.id, { amount: "1" })).status).toBe(404);
    expect((await api().post(`/api/invoices/${theirs.id}/cancel`).set(auth(owner.token))).status).toBe(404);
    expect((await api().post("/api/invoices/bulk-cancel").set(auth(owner.token)).send({ ids: [theirs.id] })).body).toEqual({
      cancelled: 0,
      skipped: 1,
    });
    expect((await api().get("/api/invoices").set(auth(owner.token))).body.total).toBe(1);
  });
});

describe("list, stats and export", () => {
  it("searches, sorts and pages", async () => {
    const owner = await ownerSession();
    const nile = await customerOf(owner.token, { name: "شركة النيل" });
    const rowad = await customerOf(owner.token, { name: "شركة الرواد" });
    await createInvoice(owner.token, nile.id, { items: [{ description: "x", quantity: 1, unitPrice: 500 }] });
    await createInvoice(owner.token, rowad.id, { items: [{ description: "x", quantity: 1, unitPrice: 3000 }] });
    await createInvoice(owner.token, nile.id, { items: [{ description: "x", quantity: 1, unitPrice: 100 }], terms: 0 });

    const numbers = async (query: string) =>
      (await api().get(`/api/invoices${query}`).set(auth(owner.token))).body.items.map((i: { number: number }) => i.number);

    expect(await numbers("")).toEqual([3, 2, 1]);
    expect(await numbers("?sort=oldest")).toEqual([1, 2, 3]);
    expect(await numbers("?sort=amount")).toEqual([2, 1, 3]);
    expect(await numbers("?sort=due")).toEqual([3, 1, 2]);
    expect(await numbers("?q=الرواد")).toEqual([2]);
    expect(await numbers("?q=%232")).toEqual([2]); // "#2"
    expect(await numbers("?q=INV-3")).toEqual([3]);
    expect(await numbers(`?customerId=${nile.id}`)).toEqual([3, 1]);
    expect(await numbers("?period=thisMonth")).toEqual([3, 2, 1]);
    expect(await numbers("?pageSize=2&page=2")).toEqual([1]);
  });

  it("stats add up what is owed, overdue, collected and in drafts", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const a = await createInvoice(owner.token, customer.id); // 1140
    await createInvoice(owner.token, customer.id, { issueDate: addDays(today(), -40), terms: 30 }); // 1140, overdue
    await createInvoice(owner.token, customer.id, { send: false }); // draft 1140
    await pay(owner.token, a.number, { amount: "140" });

    const { stats } = (await api().get("/api/invoices/stats").set(auth(owner.token))).body;
    expect(stats).toMatchObject({
      outstanding: "2140.00",
      unpaidCount: 2,
      overdue: "1140.00",
      overdueCount: 1,
      collectedThisMonth: "140.00",
      draftsCount: 1,
      draftsValue: "1140.00",
    });
  });

  it("export returns every matching invoice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    for (let i = 0; i < 4; i++) await createInvoice(owner.token, customer.id);
    const res = await api().get("/api/invoices/export?pageSize=2").set(auth(owner.token));
    expect(res.body.items).toHaveLength(4);
  });
});

describe("public link", () => {
  it("shows a sent invoice to anyone with the link, without internal details", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await createInvoice(owner.token, customer.id);

    const res = await api().get(`/api/public/invoices/${invoice.publicToken}`);
    expect(res.status).toBe(200);
    expect(res.body.invoice).toMatchObject({ number: invoice.number, total: "1140.00", issuer: { name: "شركة ميزان" } });
    expect(res.body.invoice).not.toHaveProperty("history");
    expect(res.body.invoice).not.toHaveProperty("publicToken");

    expect((await api().get("/api/public/invoices/not-a-real-token-at-all-xxxx")).status).toBe(404);
  });
});

describe("rules that protect the books", () => {
  it("a customer with invoices can't be deleted", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await createInvoice(owner.token, customer.id, { send: false });

    const res = await api().delete(`/api/customers/${customer.id}`).set(auth(owner.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CUSTOMER_HAS_INVOICES");
    const bulk = await api().post("/api/customers/bulk-delete").set(auth(owner.token)).send({ ids: [customer.id] });
    expect(bulk.status).toBe(409);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("the next invoice number can't go back to a used one", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await createInvoice(owner.token, customer.id);
    await createInvoice(owner.token, customer.id);
    const settings = (await api().get("/api/settings").set(auth(owner.token))).body.settings;

    const res = await api()
      .patch("/api/settings")
      .set(auth(owner.token))
      .send({ numbering: { ...settings.numbering, invoiceNext: 2 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVOICE_NUMBER_USED");

    const ok = await api()
      .patch("/api/settings")
      .set(auth(owner.token))
      .send({ numbering: { ...settings.numbering, invoiceNext: 100 } });
    expect(ok.status).toBe(200);
  });

  it("the customer page shows invoice totals", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const a = await createInvoice(owner.token, customer.id);
    await createInvoice(owner.token, customer.id, { send: false }); // not counted
    await pay(owner.token, a.number, { amount: "40" });

    const res = await api().get(`/api/customers/${customer.id}`).set(auth(owner.token));
    expect(res.body.customer.invoiceSummary).toEqual({ billableCount: 1, totalInvoiced: "1140.00", collected: "40.00" });
    expect(res.body.customer.balance).toBe("1100.00");
  });
});
