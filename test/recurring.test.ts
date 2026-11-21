import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, monthRange, toDate } from "../src/lib/dates.js";
import { runDueRecurring, scheduledDate } from "../src/modules/recurring/recurring.service.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function customerOf(token: string, name = "شركة النيل") {
  const res = await api().post("/api/customers").set(auth(token)).send({ name, city: "الجيزة" });
  if (res.status !== 201) throw new Error(`customer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.customer as { id: string };
}

const body = (customerId: string, extra: Record<string, unknown> = {}) => ({
  name: "دعم فني شهري",
  customerId,
  frequency: "monthly",
  startDate: addDays(today(), 1),
  endMode: "never",
  endDate: null,
  occurrences: null,
  terms: 15,
  autoSend: true,
  items: [{ description: "دعم فني", quantity: "1", unitPrice: "1000" }],
  notes: "شكراً لتعاملكم معنا",
  ...extra,
});

const post = (token: string, path: string, data?: Record<string, unknown>) =>
  api().post(`/api/recurring${path}`).set(auth(token)).send(data ?? {});
const patch = (token: string, id: string, data: Record<string, unknown>) =>
  api().patch(`/api/recurring/${id}`).set(auth(token)).send(data);
const get = (token: string, path = "") => api().get(`/api/recurring${path}`).set(auth(token));

async function create(token: string, customerId: string, extra: Record<string, unknown> = {}) {
  const res = await post(token, "", body(customerId, extra));
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.template;
}

/** Moves a template's schedule into the past, as if days had gone by (or the server had been down). */
const backdate = (id: string, data: { startDate: string; nextIndex: number; nextDate: string; endDate?: string }) =>
  prisma.recurringInvoice.update({
    where: { id },
    data: {
      startDate: toDate(data.startDate),
      nextIndex: data.nextIndex,
      nextDate: toDate(data.nextDate),
      ...(data.endDate ? { endDate: toDate(data.endDate) } : {}),
    },
  });

const invoicesOf = (recurringId: string) =>
  prisma.invoice.findMany({ where: { recurringId }, orderBy: { recurringRunDate: "asc" } });

describe("the schedule", () => {
  it("counts every date from the start date, keeping the day of the month", () => {
    expect(scheduledDate("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    expect(scheduledDate("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(scheduledDate("2024-01-31", "monthly", 1)).toBe("2024-02-29");
    expect(scheduledDate("2026-11-30", "quarterly", 1)).toBe("2027-02-28");
    expect(scheduledDate("2024-02-29", "yearly", 1)).toBe("2025-02-28");
    expect(scheduledDate("2024-02-29", "yearly", 4)).toBe("2028-02-29");
    expect(scheduledDate("2026-12-28", "weekly", 1)).toBe("2027-01-04");
    expect(scheduledDate("2026-11-20", "monthly", 0)).toBe("2026-11-20");
  });
});

describe("POST /api/recurring", () => {
  it("saves a template that starts later: no invoice yet", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id);
    expect(template).toMatchObject({
      name: "دعم فني شهري",
      customer: "شركة النيل",
      frequency: "monthly",
      status: "active",
      startDate: addDays(today(), 1),
      nextDate: addDays(today(), 1),
      generatedCount: 0,
      total: "1140.00",
      subtotal: "1000.00",
      vat: "140.00",
      terms: 15,
      autoSend: true,
      endMode: "never",
      lastInvoice: null,
      invoices: [],
    });
    expect(template.lines).toEqual([
      { id: expect.any(String), description: "دعم فني", quantity: "1", unitPrice: "1000.00", productId: null },
    ]);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("starting today makes the first invoice right away (sent, or a draft)", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const sent = await create(owner.token, customer.id, { startDate: today() });
    expect(sent).toMatchObject({ generatedCount: 1, nextDate: scheduledDate(today(), "monthly", 1) });
    expect(sent.lastInvoice).toMatchObject({ number: 1, displayNumber: "INV-1", issueDate: today() });
    expect(sent.invoices[0]).toMatchObject({ displayNumber: "INV-1", total: "1140.00", status: "sent" });

    const invoice = (await api().get("/api/invoices/1").set(auth(owner.token))).body.invoice;
    expect(invoice).toMatchObject({
      status: "sent",
      issueDate: today(),
      dueDate: addDays(today(), 15),
      total: "1140.00",
      recurring: { id: sent.id, name: "دعم فني شهري" },
    });
    // A sent invoice counts in what the customer owes.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance.toFixed(2)).toBe("1140.00");

    const draft = await create(owner.token, customer.id, { startDate: today(), autoSend: false, name: "مسودة" });
    expect(draft.invoices[0].status).toBe("draft");
  });

  it("validates the template", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const theirs = await customerOf((await ownerSession()).token, "عميل شركة تانية");

    const bad: Record<string, unknown>[] = [
      { name: "" },
      { name: "x".repeat(81) },
      { frequency: "daily" },
      { startDate: "2026-02-30" },
      { endMode: "date", endDate: null },
      { endMode: "date", endDate: addDays(today(), 1) }, // not after the start date
      { endMode: "count", occurrences: null },
      { endMode: "count", occurrences: 0 },
      { endMode: "count", occurrences: 121 },
      { terms: 400 },
      { items: [] },
      { items: [{ description: "x", quantity: "0", unitPrice: "10" }] },
    ];
    for (const extra of bad) {
      const res = await post(owner.token, "", body(customer.id, extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }

    const past = await post(owner.token, "", body(customer.id, { startDate: addDays(today(), -1) }));
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe("START_DATE_PASSED");

    const foreign = await post(owner.token, "", body(theirs.id));
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("INVALID_CUSTOMER");
    expect(await prisma.recurringInvoice.count()).toBe(0);
  });
});

describe("making the invoices", () => {
  it("catches up every date it missed, each dated on its own day, and never twice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { frequency: "weekly", startDate: today() });
    expect(template.generatedCount).toBe(1);

    // The server was down: the dates 14 and 7 days ago and today are all due.
    await backdate(template.id, { startDate: addDays(today(), -21), nextIndex: 1, nextDate: addDays(today(), -14) });
    // The first invoice above was for "today" before the backdating: move it to day 0 of the new schedule.
    await prisma.invoice.updateMany({
      where: { recurringId: template.id },
      data: { recurringRunDate: toDate(addDays(today(), -21)) },
    });

    expect(await runDueRecurring()).toMatchObject({ templates: 1, invoices: 3 });
    const invoices = await invoicesOf(template.id);
    expect(invoices.map((i) => i.issueDate.toISOString().slice(0, 10))).toEqual([
      today(), // the first invoice (made on creation)
      addDays(today(), -14),
      addDays(today(), -7),
      today(),
    ]);

    const after = (await get(owner.token, `/${template.id}`)).body.template;
    expect(after).toMatchObject({ generatedCount: 4, nextDate: addDays(today(), 7), status: "active" });

    // Running again makes nothing more.
    expect(await runDueRecurring()).toMatchObject({ invoices: 0 });
    expect(await prisma.invoice.count()).toBe(4);
  });

  it("two runs at the same moment make each invoice once", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { frequency: "weekly" });
    await backdate(template.id, { startDate: addDays(today(), -14), nextIndex: 0, nextDate: addDays(today(), -14) });

    await Promise.all([runDueRecurring(), runDueRecurring(), runDueRecurring()]);
    const invoices = await invoicesOf(template.id);
    expect(invoices.map((i) => i.issueDate.toISOString().slice(0, 10))).toEqual([
      addDays(today(), -14),
      addDays(today(), -7),
      today(),
    ]);
    const after = (await get(owner.token, `/${template.id}`)).body.template;
    expect(after).toMatchObject({ generatedCount: 3, nextDate: addDays(today(), 7) });
  });

  it("ends after the number of invoices asked for", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, {
      frequency: "monthly",
      startDate: today(),
      endMode: "count",
      occurrences: 2,
    });
    expect(template).toMatchObject({ generatedCount: 1, status: "active", occurrences: 2 });

    await backdate(template.id, { startDate: addDays(today(), -30), nextIndex: 1, nextDate: today() });
    await prisma.invoice.updateMany({ where: { recurringId: template.id }, data: { recurringRunDate: toDate(addDays(today(), -30)) } });
    await runDueRecurring();

    const after = (await get(owner.token, `/${template.id}`)).body.template;
    expect(after).toMatchObject({ generatedCount: 2, status: "ended", nextDate: null });
    expect(await runDueRecurring()).toMatchObject({ templates: 0, invoices: 0 });
  });

  it("ends after its end date", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, {
      frequency: "weekly",
      startDate: today(),
      endMode: "date",
      endDate: addDays(today(), 10),
    });

    // Due today at step 1; step 2 (in 7 days) falls after the end date (in 3 days).
    await backdate(template.id, { startDate: addDays(today(), -7), nextIndex: 1, nextDate: today(), endDate: addDays(today(), 3) });
    await prisma.invoice.updateMany({ where: { recurringId: template.id }, data: { recurringRunDate: toDate(addDays(today(), -7)) } });
    await runDueRecurring();

    const after = (await get(owner.token, `/${template.id}`)).body.template;
    expect(after).toMatchObject({ generatedCount: 2, status: "ended", nextDate: null });
  });

  it("notes a failure on the template, keeps the date, and tries again next time", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    await api()
      .post("/api/invoices")
      .set(auth(owner.token))
      .send({ customerId: customer.id, issueDate: today(), terms: 30, items: [{ description: "x", quantity: "1", unitPrice: "10" }] });
    const template = await create(owner.token, customer.id, { startDate: addDays(today(), 1) });
    await backdate(template.id, { startDate: today(), nextIndex: 0, nextDate: today() });
    // The next invoice number is already taken (set by hand in the settings).
    await prisma.company.updateMany({ data: { invoiceNextNumber: 1 } });

    expect(await runDueRecurring()).toMatchObject({ invoices: 0 });
    const failed = (await get(owner.token, `/${template.id}`)).body.template;
    expect(failed).toMatchObject({ lastError: "INVOICE_NUMBER_USED", nextDate: today(), generatedCount: 0 });

    await prisma.company.updateMany({ data: { invoiceNextNumber: 2 } });
    expect(await runDueRecurring()).toMatchObject({ invoices: 1 });
    const fixed = (await get(owner.token, `/${template.id}`)).body.template;
    expect(fixed).toMatchObject({ lastError: null, generatedCount: 1 });
  });
});

describe("pause, resume, edit, delete", () => {
  it("pauses and resumes from today on, skipping the dates missed while paused", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { frequency: "weekly" });

    const paused = await post(owner.token, `/${template.id}/pause`);
    expect(paused.body.template.status).toBe("paused");
    expect((await post(owner.token, `/${template.id}/pause`)).body.error.code).toBe("RECURRING_NOT_ACTIVE");

    // Paused for three weeks.
    await backdate(template.id, { startDate: addDays(today(), -28), nextIndex: 1, nextDate: addDays(today(), -21) });
    const resumed = await post(owner.token, `/${template.id}/resume`);
    expect(resumed.status).toBe(200);
    // Today is a scheduled date (start + 4 weeks): made right away; the three missed ones are not.
    expect(resumed.body.template).toMatchObject({ status: "active", generatedCount: 1, nextDate: addDays(today(), 7) });
    expect((await invoicesOf(template.id)).map((i) => i.issueDate.toISOString().slice(0, 10))).toEqual([today()]);

    expect((await post(owner.token, `/${template.id}/resume`)).body.error.code).toBe("RECURRING_NOT_PAUSED");
  });

  it("editing keeps the schedule, or starts it again when the start date or frequency changes", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { startDate: addDays(today(), 5) });

    const keep = await patch(owner.token, template.id, body(customer.id, {
      startDate: addDays(today(), 5),
      items: [{ description: "دعم فني", quantity: "2", unitPrice: "1000" }],
      notes: "",
    }));
    expect(keep.status).toBe(200);
    expect(keep.body.template).toMatchObject({ total: "2280.00", nextDate: addDays(today(), 5), notes: null });

    const restart = await patch(owner.token, template.id, body(customer.id, { frequency: "weekly", startDate: today() }));
    expect(restart.body.template).toMatchObject({ frequency: "weekly", generatedCount: 1, nextDate: addDays(today(), 7) });

    // Changing the start date to the past isn't allowed; keeping an old one is.
    const past = await patch(owner.token, template.id, body(customer.id, { frequency: "weekly", startDate: addDays(today(), -1) }));
    expect(past.body.error.code).toBe("START_DATE_PASSED");
    const same = await patch(owner.token, template.id, body(customer.id, { frequency: "weekly", startDate: today(), name: "جديد" }));
    expect(same.body.template).toMatchObject({ name: "جديد", generatedCount: 1, nextDate: addDays(today(), 7) });

    // Asking for at most 1 invoice when 1 is made: it ends.
    const ended = await patch(owner.token, template.id, body(customer.id, {
      frequency: "weekly",
      startDate: today(),
      endMode: "count",
      occurrences: 1,
    }));
    expect(ended.body.template).toMatchObject({ status: "ended", nextDate: null });
    expect((await patch(owner.token, template.id, body(customer.id))).body.error.code).toBe("RECURRING_ENDED");
  });

  it("a new schedule that starts on a date already invoiced doesn't count that invoice twice", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { startDate: today(), endMode: "count", occurrences: 2 });
    expect(template.generatedCount).toBe(1);

    // Monthly -> weekly, still starting today: today's invoice already exists.
    const res = await patch(owner.token, template.id, body(customer.id, {
      frequency: "weekly",
      startDate: today(),
      endMode: "count",
      occurrences: 2,
    }));
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ generatedCount: 1, status: "active", nextDate: addDays(today(), 7) });
    expect(await prisma.invoice.count()).toBe(1);
  });

  it("a date in a month that has been closed in the books is skipped, not retried forever", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id);
    const lastMonth = monthRange(today(), -1);
    const missed = addDays(lastMonth.start, 9);
    await backdate(template.id, { startDate: missed, nextIndex: 0, nextDate: missed });
    const closed = await api()
      .post("/api/ledger/periods/close")
      .set(auth(owner.token))
      .send({ month: lastMonth.start.slice(0, 7) });
    expect(closed.status).toBe(200);

    await runDueRecurring(today());
    const row = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: template.id } });
    expect(row.lastError).toBe("RECURRING_SKIPPED_CLOSED");
    expect(row.nextDate!.toISOString().slice(0, 10) > missed).toBe(true);
    expect(await prisma.invoice.count({ where: { recurringId: template.id, recurringRunDate: toDate(missed) } })).toBe(0);
    // The next date (this month) was made if it has come.
    const next = scheduledDate(missed, "monthly", 1);
    expect(await prisma.invoice.count({ where: { recurringId: template.id } })).toBe(next <= today() ? 1 : 0);
  });

  it("deleting a template keeps the invoices it made", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const template = await create(owner.token, customer.id, { startDate: today() });
    expect((await api().delete(`/api/recurring/${template.id}`).set(auth(owner.token))).status).toBe(204);
    expect(await prisma.recurringInvoice.count()).toBe(0);
    const invoice = await prisma.invoice.findFirstOrThrow();
    expect(invoice.recurringId).toBeNull();
    expect((await api().delete(`/api/recurring/${template.id}`).set(auth(owner.token))).status).toBe(404);
  });
});

describe("the list", () => {
  it("filters, counts, and adds up the monthly value and what's coming up", async () => {
    const owner = await ownerSession();
    const nile = await customerOf(owner.token);
    const rowad = await customerOf(owner.token, "شركة الرواد");
    const monthly = await create(owner.token, nile.id, { startDate: addDays(today(), 3) }); // 1140 a month, due in 3 days
    await create(owner.token, rowad.id, {
      name: "زيارة أسبوعية",
      frequency: "weekly",
      startDate: addDays(today(), 10),
      items: [{ description: "زيارة", quantity: "1", unitPrice: "100" }],
    }); // 114 a week
    const quarterly = await create(owner.token, rowad.id, {
      name: "استضافة",
      frequency: "quarterly",
      items: [{ description: "استضافة", quantity: "1", unitPrice: "3000" }],
    }); // 3420 a quarter
    await post(owner.token, `/${quarterly.id}/pause`);

    const all = (await get(owner.token)).body;
    expect(all.today).toBe(today());
    expect(all.counts).toEqual({ all: 3, active: 2, paused: 1, ended: 0 });
    // 1140 + 114 x 52 / 12 = 1140 + 494 = 1634 (the paused one doesn't count).
    expect(all.stats).toEqual({ mrr: "1634.00", active: 2, paused: 1, upcoming: { count: 1, total: "1140.00" } });
    expect(all.items.map((i: { name: string }) => i.name)).toEqual(["دعم فني شهري", "زيارة أسبوعية", "استضافة"]);
    expect(all.items[0]).toMatchObject({ id: monthly.id, nextDate: addDays(today(), 3), lastInvoice: null });

    const names = async (query: string) => (await get(owner.token, query)).body.items.map((i: { name: string }) => i.name);
    expect(await names("?status=paused")).toEqual(["استضافة"]);
    expect(await names("?q=الرواد")).toEqual(["زيارة أسبوعية", "استضافة"]);
    expect((await get(owner.token, "?q=الرواد")).body.counts).toEqual({ all: 2, active: 1, paused: 1, ended: 0 });
    expect((await get(owner.token, "?status=nope")).status).toBe(400);
  });
});

describe("permissions and isolation", () => {
  it("everyone can see them; owner and accountant change them", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    const mine = await create(accountant.token, customer.id);
    for (const user of [sales, viewer]) {
      expect((await get(user.token)).status).toBe(200);
      expect((await get(user.token, `/${mine.id}`)).status).toBe(200);
      expect((await post(user.token, "", body(customer.id))).status).toBe(403);
      expect((await patch(user.token, mine.id, body(customer.id))).status).toBe(403);
      expect((await post(user.token, `/${mine.id}/pause`)).status).toBe(403);
      expect((await api().delete(`/api/recurring/${mine.id}`).set(auth(user.token))).status).toBe(403);
    }
  });

  it("another company's templates are out of reach", async () => {
    const mine = await ownerSession();
    const theirs = await ownerSession();
    const their = await create(theirs.token, (await customerOf(theirs.token)).id);
    const myCustomer = await customerOf(mine.token);

    expect((await get(mine.token)).body.items).toEqual([]);
    expect((await get(mine.token, `/${their.id}`)).status).toBe(404);
    expect((await patch(mine.token, their.id, body(myCustomer.id))).status).toBe(404);
    expect((await post(mine.token, `/${their.id}/pause`)).status).toBe(404);
    expect((await post(mine.token, `/${their.id}/resume`)).status).toBe(404);
    expect((await api().delete(`/api/recurring/${their.id}`).set(auth(mine.token))).status).toBe(404);
    expect((await get(mine.token, "/not-a-uuid")).status).toBe(404);
    expect(await prisma.recurringInvoice.count()).toBe(1);
  });
});
