import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange, toDate, yearRange } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function customerOf(token: string, body: Record<string, unknown> = {}) {
  const res = await api()
    .post("/api/customers")
    .set(auth(token))
    .send({ name: "شركة النيل", taxNumber: "412-558-903", email: "nile@example.com", city: "الجيزة", ...body });
  if (res.status !== 201) throw new Error(`customer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.customer as { id: string };
}

async function productOf(token: string) {
  const res = await api()
    .post("/api/products")
    .set(auth(token))
    .send({ name: "تطوير موقع", type: "service", code: `SRV-${Math.floor(Math.random() * 1e6)}`, price: "1000", taxRate: "14", category: "software" });
  if (res.status !== 201) throw new Error(`product failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.product as { id: string };
}

type Item = { description: string; quantity: string | number; unitPrice: string | number; productId?: string | null };
const oneItem: Item[] = [{ description: "تطوير موقع", quantity: "1", unitPrice: "1000" }];
const amount = (unitPrice: string): Item[] => [{ description: "بند", quantity: "1", unitPrice }];

type QuoteOptions = { items?: Item[]; send?: boolean; issueDate?: string; validUntil?: string; notes?: string };

const quoteBody = (customerId: string, { items = oneItem, send, issueDate = today(), validUntil, notes }: QuoteOptions = {}) => ({
  customerId,
  issueDate,
  validUntil: validUntil ?? addDays(issueDate, 30),
  items,
  notes,
  send,
});

async function createQuote(token: string, customerId: string, options: QuoteOptions = {}) {
  // A quote can't be sent already expired: for an expired one, send it valid through
  // today, then let its validity run out (set straight in the database).
  const expired = options.send === true && options.validUntil !== undefined && options.validUntil < today();
  const body = quoteBody(customerId, expired ? { ...options, validUntil: today() } : options);
  const res = await api().post("/api/quotes").set(auth(token)).send(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (!expired) return res.body.quote;

  await prisma.quote.update({ where: { id: res.body.quote.id }, data: { validUntil: toDate(options.validUntil!) } });
  return (await api().get(`/api/quotes/${res.body.quote.id}`).set(auth(token))).body.quote;
}

const post = (token: string, path: string, body?: Record<string, unknown>) =>
  api().post(`/api/quotes${path}`).set(auth(token)).send(body ?? {});
const get = (token: string, path = "") => api().get(`/api/quotes${path}`).set(auth(token));

/** A sent quote the customer (or the user) has accepted. */
async function acceptedQuote(token: string, customerId: string, options: QuoteOptions = {}) {
  const quote = await createQuote(token, customerId, { send: true, ...options });
  const res = await post(token, `/${quote.number}/accept`);
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.quote;
}

const convert = (token: string, customerId: string, fromQuote: unknown) =>
  api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate: today(), terms: 30, items: oneItem, send: true, fromQuote });

async function updateSettings(token: string, change: (s: Record<string, Record<string, unknown>>) => Record<string, unknown>) {
  const settings = (await api().get("/api/settings").set(auth(token))).body.settings;
  return api().patch("/api/settings").set(auth(token)).send(change(settings));
}

const vatOff = (token: string) => updateSettings(token, (s) => ({ taxes: { ...s["taxes"], vatEnabled: false } }));

const types = (quote: { history: { type: string }[] }) => quote.history.map((h) => h.type);

describe("creating a quote", () => {
  it("numbers quotes with the prefix, works out the totals and keeps a draft", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);

    const quote = await createQuote(owner.token, customer.id, {
      items: [
        { description: "ساعات عمل", quantity: "3", unitPrice: "33.33" }, // 99.99
        { description: "كابل", quantity: "2.5", unitPrice: "10.01" }, // 25.025 -> 25.03
      ],
      validUntil: addDays(today(), 14),
      notes: "السعر شامل التركيب",
    });

    expect(quote).toMatchObject({
      number: 1,
      displayNumber: "Q-1",
      status: "draft",
      daysLeft: null,
      customerId: customer.id,
      customer: "شركة النيل",
      issueDate: today(),
      validUntil: addDays(today(), 14),
      subtotal: "125.02",
      vatRate: "14.00",
      vat: "17.50",
      total: "142.52",
      rounding: "0.00",
      currency: "EGP",
      note: "السعر شامل التركيب",
      invoice: null,
      publicToken: null,
      sentAt: null,
      decidedAt: null,
      decidedBy: null,
      issuer: { name: "شركة ميزان" },
      client: { name: "شركة النيل", taxNumber: "412-558-903", email: "nile@example.com", location: "الجيزة" },
    });
    expect(quote.lines).toMatchObject([
      { title: "ساعات عمل", quantity: "3", unitPrice: "33.33", amount: "99.99", productId: null },
      { title: "كابل", quantity: "2.5", unitPrice: "10.01", amount: "25.03", productId: null },
    ]);
    expect(quote.history).toMatchObject([{ type: "created", values: { name: "محمد أحمد" } }]);

    expect((await createQuote(owner.token, customer.id)).displayNumber).toBe("Q-2");
  });

  it("follows the numbering and VAT settings, and the next number can't go back", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await updateSettings(owner.token, (s) => ({
      numbering: { ...s["numbering"], quotePrefix: "QT-", quoteNext: 212 },
      taxes: { ...s["taxes"], vatEnabled: false },
    }));

    const quote = await createQuote(owner.token, customer.id);
    expect(quote).toMatchObject({ number: 212, displayNumber: "QT-212", vatRate: "0.00", vat: "0.00", total: "1000.00" });
    expect((await api().get("/api/settings").set(auth(owner.token))).body.settings.numbering.quoteNext).toBe(213);

    const back = await updateSettings(owner.token, (s) => ({ numbering: { ...s["numbering"], quoteNext: 212 } }));
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("QUOTE_NUMBER_USED");
  });

  it("never gives two quotes the same number, even at the same moment", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api().post("/api/quotes").set(auth(owner.token)).send(quoteBody(customer.id))),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(results.map((r) => r.body.quote.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("save and send: gets a public link and counts the days left", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const product = await productOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, {
      send: true,
      validUntil: addDays(today(), 10),
      items: [{ ...oneItem[0]!, productId: product.id }],
    });

    expect(quote).toMatchObject({ status: "sent", daysLeft: 10 });
    expect(quote.lines[0].productId).toBe(product.id);
    expect(quote.publicToken).toMatch(/^[\w-]{43}$/);
    expect(quote.sentAt).toBeTruthy();
    expect(types(quote)).toEqual(["sent", "created"]);
  });

  it("validates the input", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const customer = await customerOf(owner.token);
    const theirCustomer = await customerOf(other.token);
    const theirProduct = await productOf(other.token);
    const send = (body: Record<string, unknown>) =>
      api().post("/api/quotes").set(auth(owner.token)).send({ ...quoteBody(customer.id), ...body });

    for (const body of [
      { validUntil: today() }, // must be after the issue date
      { validUntil: addDays(today(), -1) },
      { items: [] },
      { items: Array.from({ length: 101 }, () => oneItem[0]) },
      { items: [{ description: "", quantity: "1", unitPrice: "1" }] },
      { items: [{ description: "x".repeat(501), quantity: "1", unitPrice: "1" }] },
      { items: [{ description: "x", quantity: "0", unitPrice: "1" }] },
      { items: [{ description: "x", quantity: "1.0001", unitPrice: "1" }] },
      { items: [{ description: "x", quantity: "1", unitPrice: "-1" }] },
      { items: [{ description: "x", quantity: "1", unitPrice: "1.005" }] },
      { items: [{ description: "x", quantity: "1", unitPrice: "1", productId: "not-a-uuid" }] },
      { issueDate: "2026-02-30" },
      { customerId: "nope" },
      { notes: "x".repeat(501) },
    ]) {
      expect((await send(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const tooEarly = await send({ validUntil: today() });
    expect(tooEarly.body.error.details.fieldErrors.validUntil).toBeTruthy();

    expect((await send({ customerId: theirCustomer.id })).body.error.code).toBe("INVALID_CUSTOMER");
    const foreignProduct = await send({ items: [{ ...oneItem[0]!, productId: theirProduct.id }] });
    expect(foreignProduct.status).toBe(400);
    expect(foreignProduct.body.error.code).toBe("INVALID_PRODUCT");

    expect(await prisma.quote.count()).toBe(0);
    // Nothing was used up: the first real quote is still number 1.
    expect((await createQuote(owner.token, customer.id)).number).toBe(1);
  });

  it("a quote can't be sent with a date after today; a draft can, until it is sent", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const tomorrow = addDays(today(), 1);

    const sentNow = await post(owner.token, "", quoteBody(customer.id, { issueDate: tomorrow, send: true }));
    expect(sentNow.status).toBe(400);
    expect(sentNow.body.error.code).toBe("FUTURE_ISSUE_DATE");

    const draft = await createQuote(owner.token, customer.id, { issueDate: tomorrow });
    const send = await post(owner.token, `/${draft.number}/send`);
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe("FUTURE_ISSUE_DATE");
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("draft");
  });

  it("a quote whose validity has passed can't be sent (it would reach the customer expired)", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const passed = { issueDate: addDays(today(), -20), validUntil: addDays(today(), -1) };

    const sentNow = await post(owner.token, "", quoteBody(customer.id, { ...passed, send: true }));
    expect(sentNow.status).toBe(400);
    expect(sentNow.body.error.code).toBe("QUOTE_VALIDITY_PASSED");

    const draft = await createQuote(owner.token, customer.id, passed);
    const send = await post(owner.token, `/${draft.number}/send`);
    expect(send.status).toBe(409);
    expect(send.body.error.code).toBe("QUOTE_VALIDITY_PASSED");
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("draft");

    // Valid through today: fine.
    const lastDay = await createQuote(owner.token, customer.id, { ...passed, validUntil: today() });
    expect((await post(owner.token, `/${lastDay.number}/send`)).status).toBe(200);
  });
});

describe("editing a draft", () => {
  it("replaces the customer, dates, notes and lines, with totals from the current VAT setting", async () => {
    const owner = await ownerSession();
    const nile = await customerOf(owner.token);
    const rowad = await customerOf(owner.token, { name: "شركة الرواد", email: null, taxNumber: null, city: "القاهرة" });
    const quote = await createQuote(owner.token, nile.id, {
      items: [
        { description: "أ", quantity: "1", unitPrice: "100" },
        { description: "ب", quantity: "2", unitPrice: "50" },
      ],
      notes: "ملاحظة",
    });
    await vatOff(owner.token);

    const res = await api()
      .patch(`/api/quotes/${quote.number}`)
      .set(auth(owner.token))
      .send({
        customerId: rowad.id,
        issueDate: addDays(today(), -1),
        validUntil: addDays(today(), 6),
        items: [{ description: "ج", quantity: "4", unitPrice: "25.5" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({
      id: quote.id,
      number: quote.number,
      status: "draft",
      customerId: rowad.id,
      customer: "شركة الرواد",
      client: { name: "شركة الرواد", email: null, taxNumber: null, location: "القاهرة" },
      issueDate: addDays(today(), -1),
      validUntil: addDays(today(), 6),
      subtotal: "102.00",
      vatRate: "0.00",
      vat: "0.00",
      total: "102.00",
      note: null,
    });
    expect(res.body.quote.lines).toMatchObject([{ title: "ج", quantity: "4", unitPrice: "25.50", amount: "102.00" }]);
    expect(await prisma.quoteLine.count({ where: { quoteId: quote.id } })).toBe(1);
  });

  it("only a draft can be edited, and the same rules apply", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const draft = await createQuote(owner.token, customer.id);
    const sent = await createQuote(owner.token, customer.id, { send: true });
    const patch = (ref: string | number, body: Record<string, unknown>) =>
      api().patch(`/api/quotes/${ref}`).set(auth(owner.token)).send({ ...quoteBody(customer.id), ...body });

    const res = await patch(sent.number, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("QUOTE_NOT_DRAFT");

    expect((await patch(draft.number, { validUntil: today() })).status).toBe(400);
    expect((await patch(draft.number, { items: [] })).status).toBe(400);
    expect((await patch(999, {})).status).toBe(404);
  });
});

describe("send, accept and reject", () => {
  it("moves draft -> sent -> accepted, and refuses the moves that don't fit", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id);

    const early = await post(owner.token, `/${quote.number}/accept`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("QUOTE_NOT_SENT");

    const sent = await post(owner.token, `/${quote.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.quote).toMatchObject({ status: "sent", daysLeft: 30 });
    expect(sent.body.quote.publicToken).toBeTruthy();

    const again = await post(owner.token, `/${quote.id}/send`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("QUOTE_NOT_DRAFT");

    const accepted = await post(owner.token, `/${quote.number}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.quote).toMatchObject({ status: "accepted", decidedBy: "user", daysLeft: null });
    expect(accepted.body.quote.decidedAt).toBeTruthy();
    expect(accepted.body.quote.history[0]).toMatchObject({ type: "accepted", values: { by: "user" } });
    expect(types(accepted.body.quote)).toEqual(["accepted", "sent", "created"]);

    for (const path of ["accept", "reject"]) {
      const res = await post(owner.token, `/${quote.number}/${path}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("QUOTE_NOT_SENT");
    }
    expect((await post(owner.token, `/${quote.number}/send`)).body.error.code).toBe("QUOTE_NOT_DRAFT");
  });

  it("rejects a sent quote", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, { send: true });

    const res = await post(owner.token, `/${quote.number}/reject`);
    expect(res.body.quote).toMatchObject({ status: "rejected", decidedBy: "user" });
    expect(res.body.quote.history[0]).toMatchObject({ type: "rejected", values: { by: "user" } });
  });

  it("a sent quote past its validity shows as expired; the user can still record a late answer", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, {
      send: true,
      issueDate: addDays(today(), -20),
      validUntil: addDays(today(), -1),
    });
    expect(quote).toMatchObject({ status: "expired", daysLeft: null });

    // validUntil = today is still open (last day).
    const lastDay = await createQuote(owner.token, customer.id, { send: true, issueDate: addDays(today(), -5), validUntil: today() });
    expect(lastDay).toMatchObject({ status: "sent", daysLeft: 0 });

    const late = await post(owner.token, `/${quote.number}/accept`);
    expect(late.status).toBe(200);
    expect(late.body.quote.status).toBe("accepted");
  });

  it("two clicks on accept at the same moment record one answer", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, { send: true });

    const results = await Promise.all([post(owner.token, `/${quote.number}/accept`), post(owner.token, `/${quote.number}/reject`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.quoteEvent.count({ where: { quoteId: quote.id, type: { in: ["accepted", "rejected"] } } })).toBe(1);
  });
});

describe("list", () => {
  it("filters by status, searches, filters by period and pages; counts follow the search and period", async () => {
    const owner = await ownerSession();
    const nile = await customerOf(owner.token, { name: "شركة النيل" });
    const rowad = await customerOf(owner.token, { name: "شركة الرواد" });

    const q1 = await createQuote(owner.token, nile.id); // draft
    const q2 = await createQuote(owner.token, rowad.id, { send: true }); // sent
    const q3 = await createQuote(owner.token, nile.id, { send: true }); // expired (dates moved below)
    const q4 = await acceptedQuote(owner.token, nile.id); // accepted
    const q5 = await createQuote(owner.token, rowad.id, { send: true });
    await post(owner.token, `/${q5.number}/reject`); // rejected
    const q6 = await createQuote(owner.token, nile.id); // draft, dated last year (below)

    const lastMonth = monthRange(today(), -1);
    const lastYear = yearRange(today(), -1);
    await prisma.quote.update({
      where: { id: q3.id },
      data: { issueDate: toDate(lastMonth.start), validUntil: toDate(lastMonth.end) },
    });
    await prisma.quote.update({
      where: { id: q6.id },
      data: { issueDate: toDate(lastYear.start), validUntil: toDate(addDays(lastYear.start, 30)) },
    });

    const list = (query = "") => get(owner.token, query);
    const numbers = async (query: string) => (await list(query)).body.items.map((i: { number: number }) => i.number);

    const all = await list();
    expect(all.body).toMatchObject({
      total: 6,
      page: 1,
      pageSize: 20,
      counts: { all: 6, draft: 2, sent: 1, accepted: 1, rejected: 1, expired: 1 },
    });
    expect(all.body.items.map((i: { number: number }) => i.number)).toEqual([6, 5, 4, 3, 2, 1]);
    const expired = all.body.items.find((i: { number: number }) => i.number === q3.number);
    expect(expired).toMatchObject({
      status: "expired",
      daysLeft: null,
      displayNumber: "Q-3",
      customer: "شركة النيل",
      customerId: nile.id,
      issueDate: lastMonth.start,
      validUntil: lastMonth.end,
      total: "1140.00",
      invoice: null,
    });
    expect(Object.keys(all.body.items[0]).sort()).toEqual(
      ["id", "number", "displayNumber", "customerId", "customer", "issueDate", "validUntil", "total", "status", "daysLeft", "invoice"].sort(),
    );

    expect(await numbers("?status=draft")).toEqual([q6.number, q1.number]);
    expect(await numbers("?status=sent")).toEqual([q2.number]);
    expect(await numbers("?status=expired")).toEqual([q3.number]);
    expect(await numbers("?status=accepted")).toEqual([q4.number]);
    expect(await numbers("?status=rejected")).toEqual([q5.number]);

    const search = await list("?q=الرواد&status=sent");
    expect(search.body.items.map((i: { number: number }) => i.number)).toEqual([q2.number]);
    expect(search.body.counts).toEqual({ all: 2, draft: 0, sent: 1, accepted: 0, rejected: 1, expired: 0 });
    expect(await numbers("?q=%233")).toEqual([3]); // "#3"
    expect(await numbers("?q=Q-4")).toEqual([4]);
    expect(await numbers("?q=2")).toEqual([2]);

    const month = await list("?period=month");
    expect(month.body.items.map((i: { number: number }) => i.number)).toEqual([5, 4, 2, 1]);
    expect(month.body.counts).toEqual({ all: 4, draft: 1, sent: 1, accepted: 1, rejected: 1, expired: 0 });
    expect(await numbers("?period=lastMonth")).toEqual([3]);
    // Last month is in this year unless today is in January.
    const lastMonthThisYear = lastMonth.start.slice(0, 4) === today().slice(0, 4);
    expect(await numbers("?period=year")).toEqual(lastMonthThisYear ? [5, 4, 3, 2, 1] : [5, 4, 2, 1]);

    const page = await list("?pageSize=4&page=2");
    expect(page.body).toMatchObject({ total: 6, page: 2, pageSize: 4 });
    expect(page.body.items.map((i: { number: number }) => i.number)).toEqual([2, 1]);

    for (const query of ["?pageSize=101", "?status=paid", "?period=thisMonth", "?page=0"]) {
      expect((await list(query)).status, query).toBe(400);
    }
  });
});

describe("stats", () => {
  it("adds up what is waiting, accepted this month (Cairo), expiring soon, and the acceptance rate", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await vatOff(owner.token);
    const t = today();
    const month = monthRange(t);

    const sent = (unitPrice: string, validUntil: string, issueDate = t) =>
      createQuote(owner.token, customer.id, { send: true, items: amount(unitPrice), issueDate, validUntil });

    await sent("100", addDays(t, 30)); // waiting
    await sent("200", addDays(t, 3)); // waiting, expiring
    await sent("400", t, addDays(t, -5)); // waiting, expiring (last day)
    await sent("800", addDays(t, -1), addDays(t, -20)); // expired: decided (no answer) for the rate
    await sent("1600", addDays(t, 8)); // waiting, not expiring yet
    await acceptedQuote(owner.token, customer.id, { items: amount("1000") }); // accepted now
    const lastMonth = await acceptedQuote(owner.token, customer.id, { items: amount("2000") });
    const rejected = await createQuote(owner.token, customer.id, { send: true, items: amount("3000") });
    await post(owner.token, `/${rejected.number}/reject`);
    const old = await acceptedQuote(owner.token, customer.id, { items: amount("5000") });
    await createQuote(owner.token, customer.id, { items: amount("9000") }); // draft: counts nowhere

    // Decided just before this month started in Cairo (still last month there).
    await prisma.quote.update({
      where: { id: lastMonth.id },
      data: { decidedAt: new Date(toDate(month.start).getTime() - 4 * 3600_000) },
    });
    // Decided in the first hour of this month in Cairo (the day before in UTC), and
    // issued too long ago to count in the acceptance rate.
    await prisma.quote.update({
      where: { id: old.id },
      data: { decidedAt: new Date(toDate(month.start).getTime() - 30 * 60_000), issueDate: toDate(addDays(t, -100)) },
    });

    const res = await get(owner.token, "/stats");
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual({
      waiting: { count: 4, total: "2300.00" },
      accepted: { count: 2, total: "6000.00" },
      expiring: { count: 2, total: "600.00" },
      // In the last 90 days: 2 accepted, 1 rejected, 1 expired.
      acceptanceRate: 50,
    });
  });

  it("shows zeros and no rate when nothing was decided", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await createQuote(owner.token, customer.id);

    const res = await get(owner.token, "/stats");
    expect(res.body.stats).toEqual({
      waiting: { count: 0, total: "0.00" },
      accepted: { count: 0, total: "0.00" },
      expiring: { count: 0, total: "0.00" },
      acceptanceRate: null,
    });
  });
});

describe("duplicate", () => {
  it("makes a new draft dated today with the same customer, lines, notes and validity length", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const product = await productOf(owner.token);
    const original = await createQuote(owner.token, customer.id, {
      send: true,
      issueDate: addDays(today(), -10),
      validUntil: addDays(today(), 5),
      notes: "عرض خاص",
      items: [
        { description: "أ", quantity: "1.5", unitPrice: "100", productId: product.id },
        { description: "ب", quantity: "2", unitPrice: "50.25" },
      ],
    });
    await post(owner.token, `/${original.number}/reject`);

    const res = await post(owner.token, `/${original.id}/duplicate`);
    expect(res.status).toBe(201);
    expect(res.body.quote).toMatchObject({
      number: original.number + 1,
      status: "draft",
      customerId: customer.id,
      issueDate: today(),
      validUntil: addDays(today(), 15),
      note: "عرض خاص",
      subtotal: original.subtotal,
      total: original.total,
      publicToken: null,
      decidedAt: null,
      decidedBy: null,
    });
    expect(res.body.quote.id).not.toBe(original.id);
    expect(res.body.quote.lines.map(({ id: _id, ...line }: { id: string }) => line)).toEqual(
      original.lines.map(({ id: _id, ...line }: { id: string }) => line),
    );
    expect(types(res.body.quote)).toEqual(["created"]);
    // The original is untouched.
    expect((await get(owner.token, `/${original.number}`)).body.quote.status).toBe("rejected");
  });

  it("refuses when the customer was deleted", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id);
    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(owner.token))).status).toBe(204);

    const res = await post(owner.token, `/${quote.number}/duplicate`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CUSTOMER");
  });
});

describe("delete", () => {
  it("a draft by anyone who writes quotes; a sent one by the owner only", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");
    const del = (token: string, ref: string | number) => api().delete(`/api/quotes/${ref}`).set(auth(token));

    const draft1 = await createQuote(owner.token, customer.id);
    const draft2 = await createQuote(owner.token, customer.id);
    const sent = await createQuote(owner.token, customer.id, { send: true });
    const accepted = await acceptedQuote(owner.token, customer.id);

    expect((await del(viewer.token, draft1.number)).status).toBe(403);
    expect((await del(sales.token, draft1.number)).status).toBe(204);
    expect((await del(accountant.token, draft2.id)).status).toBe(204);

    for (const { token } of [sales, accountant]) {
      const res = await del(token, sent.number);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    expect((await del(owner.token, sent.number)).status).toBe(204);
    expect((await del(owner.token, accepted.id)).status).toBe(204);
    expect((await del(owner.token, accepted.id)).status).toBe(404);

    expect(await prisma.quote.count()).toBe(0);
    expect(await prisma.quoteLine.count()).toBe(0);
    expect(await prisma.quoteEvent.count()).toBe(0);
  });
});

describe("permissions by role", () => {
  it("everyone reads; owner, accountant and sales write; the viewer can't", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, { send: true });
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    for (const { token } of [owner, accountant, sales, viewer]) {
      expect((await get(token)).status).toBe(200);
      expect((await get(token, "/stats")).status).toBe(200);
      expect((await get(token, `/${quote.number}`)).status).toBe(200);
    }

    // Sales creates, sends and records the answer.
    const mine = await createQuote(sales.token, customer.id);
    expect((await post(sales.token, `/${mine.number}/send`)).status).toBe(200);
    expect((await post(sales.token, `/${mine.number}/accept`)).status).toBe(200);
    expect((await post(accountant.token, `/${quote.number}/reject`)).status).toBe(200);

    const draft = await createQuote(owner.token, customer.id);
    const viewerCalls = [
      post(viewer.token, "", quoteBody(customer.id)),
      api().patch(`/api/quotes/${draft.number}`).set(auth(viewer.token)).send(quoteBody(customer.id)),
      post(viewer.token, `/${draft.number}/send`),
      post(viewer.token, `/${draft.number}/accept`),
      post(viewer.token, `/${draft.number}/reject`),
      post(viewer.token, `/${draft.number}/duplicate`),
      api().delete(`/api/quotes/${draft.number}`).set(auth(viewer.token)),
    ];
    for (const res of await Promise.all(viewerCalls)) expect(res.status).toBe(403);
    expect(await prisma.quote.count()).toBe(3);

    // Converting makes an invoice: owner and accountant only.
    expect((await convert(sales.token, customer.id, mine.number)).status).toBe(403);
    const converted = await convert(accountant.token, customer.id, mine.number);
    expect(converted.status).toBe(201);
  });
});

describe("company isolation", () => {
  it("another company's quotes can't be seen or touched, by id or by number", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirCustomer = await customerOf(other.token);
    const theirs = await createQuote(other.token, theirCustomer.id, { send: true });
    const theirAccepted = await acceptedQuote(other.token, theirCustomer.id);
    const customer = await customerOf(owner.token);

    for (const res of [
      await get(owner.token, `/${theirs.id}`),
      await get(owner.token, `/${theirs.number}`),
      await api().patch(`/api/quotes/${theirs.id}`).set(auth(owner.token)).send(quoteBody(customer.id)),
      await post(owner.token, `/${theirs.id}/send`),
      await post(owner.token, `/${theirs.id}/accept`),
      await post(owner.token, `/${theirs.id}/reject`),
      await post(owner.token, `/${theirs.id}/duplicate`),
      await api().delete(`/api/quotes/${theirs.id}`).set(auth(owner.token)),
      // Their quote numbers mean nothing here.
      await convert(owner.token, customer.id, theirAccepted.number),
    ]) {
      expect(res.status).toBe(404);
    }

    const list = await get(owner.token);
    expect(list.body.total).toBe(0);
    expect(list.body.counts.all).toBe(0);
    expect((await get(owner.token, "/stats")).body.stats.waiting.count).toBe(0);
    expect(await prisma.quote.count({ where: { companyId: other.companyId, status: "sent" } })).toBe(1);
    expect(await prisma.invoice.count()).toBe(0);
  });
});

describe("public link", () => {
  it("shows a sent quote without login and lets the customer accept it once", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, { send: true });

    const view = await api().get(`/api/public/quotes/${quote.publicToken}`);
    expect(view.status).toBe(200);
    expect(view.body.quote).toMatchObject({
      number: quote.number,
      displayNumber: "Q-1",
      status: "sent",
      total: "1140.00",
      issuer: { name: "شركة ميزان" },
      client: { name: "شركة النيل" },
    });
    // Only what the customer reads: no internal ids, token, history, invoice or who answered.
    for (const hidden of ["id", "publicToken", "history", "customerId", "invoice", "decidedBy", "createdAt"]) {
      expect(view.body.quote).not.toHaveProperty(hidden);
    }
    expect(view.body.quote.lines).toEqual([
      { id: "1", title: "تطوير موقع", quantity: "1", unitPrice: "1000.00", amount: "1000.00" },
    ]);

    const accept = await api().post(`/api/public/quotes/${quote.publicToken}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.quote).toMatchObject({ status: "accepted" });
    expect(accept.body.quote.decidedAt).toBeTruthy();
    expect(accept.body.quote).not.toHaveProperty("history");
    expect(accept.body.quote).not.toHaveProperty("decidedBy");

    for (const path of ["accept", "reject"]) {
      const again = await api().post(`/api/public/quotes/${quote.publicToken}/${path}`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("QUOTE_NOT_OPEN");
    }

    const detail = (await get(owner.token, `/${quote.number}`)).body.quote;
    expect(detail).toMatchObject({ status: "accepted", decidedBy: "customer" });
    expect(detail.history[0]).toMatchObject({ type: "accepted", values: { by: "customer" } });
    const event = await prisma.quoteEvent.findFirstOrThrow({ where: { quoteId: quote.id, type: "accepted" } });
    expect(event.userId).toBeNull();
  });

  it("the customer can reject", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await createQuote(owner.token, customer.id, { send: true });

    const res = await api().post(`/api/public/quotes/${quote.publicToken}/reject`);
    expect(res.body.quote).toMatchObject({ status: "rejected" });
    expect((await get(owner.token, `/${quote.number}`)).body.quote.decidedBy).toBe("customer");
  });

  it("an expired quote can be viewed but not answered; drafts and unknown links are 404", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const expired = await createQuote(owner.token, customer.id, {
      send: true,
      issueDate: addDays(today(), -30),
      validUntil: addDays(today(), -1),
    });
    expect((await api().get(`/api/public/quotes/${expired.publicToken}`)).body.quote.status).toBe("expired");
    const late = await api().post(`/api/public/quotes/${expired.publicToken}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("QUOTE_NOT_OPEN");

    // A draft never has a link; even with a token it isn't shown.
    const draft = await createQuote(owner.token, customer.id);
    const token = "a".repeat(43);
    await prisma.quote.update({ where: { id: draft.id }, data: { publicToken: token } });
    expect((await api().get(`/api/public/quotes/${token}`)).status).toBe(404);
    expect((await api().post(`/api/public/quotes/${token}/accept`)).status).toBe(404);

    expect((await api().get("/api/public/quotes/not-a-real-token-at-all-xxxx")).status).toBe(404);
    expect((await api().post("/api/public/quotes/short/accept")).status).toBe(404);
    expect(await prisma.quote.count({ where: { status: { in: ["accepted", "rejected"] } } })).toBe(0);
  });
});

describe("converting to an invoice", () => {
  it("an accepted quote becomes an invoice once, and is linked to it", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await acceptedQuote(owner.token, customer.id);

    const res = await convert(owner.token, customer.id, quote.number);
    expect(res.status).toBe(201);
    const invoice = res.body.invoice;
    expect(invoice).toMatchObject({ number: 1, displayNumber: "INV-1", status: "sent" });

    const detail = (await get(owner.token, `/${quote.number}`)).body.quote;
    expect(detail.invoice).toEqual({ id: invoice.id, number: 1, displayNumber: "INV-1" });
    expect(detail.history[0]).toMatchObject({ type: "converted", values: { invoiceNumber: 1, displayNumber: "INV-1" } });
    expect((await get(owner.token, "?status=accepted")).body.items[0].invoice).toEqual(detail.invoice);

    const again = await convert(owner.token, customer.id, quote.number);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("QUOTE_ALREADY_CONVERTED");
    expect(await prisma.invoice.count()).toBe(1);
    // The refused attempt used up no invoice number.
    expect((await convert(owner.token, customer.id, undefined)).body.invoice.number).toBe(2);

    const del = await api().delete(`/api/quotes/${quote.number}`).set(auth(owner.token));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("QUOTE_CONVERTED");
    expect(await prisma.quote.count()).toBe(1);
  });

  it("refuses a quote that isn't accepted or doesn't exist, and creates no invoice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const draft = await createQuote(owner.token, customer.id);
    const sent = await createQuote(owner.token, customer.id, { send: true });
    const rejected = await createQuote(owner.token, customer.id, { send: true });
    await post(owner.token, `/${rejected.number}/reject`);

    for (const quote of [draft, sent, rejected]) {
      const res = await convert(owner.token, customer.id, quote.number);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("QUOTE_NOT_ACCEPTED");
    }
    expect((await convert(owner.token, customer.id, 999)).status).toBe(404);
    expect((await convert(owner.token, customer.id, "abc")).status).toBe(400);
    expect((await convert(owner.token, customer.id, 0)).status).toBe(400);

    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.quote.count({ where: { convertedInvoiceId: { not: null } } })).toBe(0);
  });

  it("the invoice must be for the quote's customer", async () => {
    const owner = await ownerSession();
    const nile = await customerOf(owner.token);
    const rowad = await customerOf(owner.token, { name: "شركة الرواد" });
    const quote = await acceptedQuote(owner.token, nile.id);

    const other = await convert(owner.token, rowad.id, quote.number);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("QUOTE_CUSTOMER_MISMATCH");
    expect(await prisma.invoice.count()).toBe(0);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } })).convertedInvoiceId).toBeNull();

    expect((await convert(owner.token, nile.id, quote.number)).status).toBe(201);
  });

  it("lists the accepted quotes still to invoice (converted=false)", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const done = await acceptedQuote(owner.token, customer.id);
    const waiting = await acceptedQuote(owner.token, customer.id);
    await convert(owner.token, customer.id, done.number);

    const numbers = async (query: string) =>
      (await get(owner.token, query)).body.items.map((q: { number: number }) => q.number);
    expect(await numbers("?status=accepted&converted=false")).toEqual([waiting.number]);
    expect(await numbers("?status=accepted&converted=true")).toEqual([done.number]);
    expect((await get(owner.token, "?converted=maybe")).status).toBe(400);
  });

  it("two conversions of the same quote at the same moment make one invoice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const quote = await acceptedQuote(owner.token, customer.id);

    const results = await Promise.all([
      convert(owner.token, customer.id, quote.number),
      convert(owner.token, customer.id, String(quote.number)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.invoice.count()).toBe(1);
    expect(await prisma.quoteEvent.count({ where: { type: "converted" } })).toBe(1);
  });
});

describe("when the customer is deleted", () => {
  it("the quote keeps the customer's name and loses the link", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token, { name: "عميل سابق" });
    const quote = await createQuote(owner.token, customer.id, { send: true });

    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(owner.token))).status).toBe(204);

    const detail = (await get(owner.token, `/${quote.number}`)).body.quote;
    expect(detail).toMatchObject({ customerId: null, customer: "عميل سابق", client: { name: "عميل سابق" } });
    expect((await get(owner.token, "?q=سابق")).body.items).toHaveLength(1);
  });
});
