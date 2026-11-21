import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday, toDate } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function ok(res: { status: number; body: any }, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
const post = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/deals${path}`).set(auth(token)).send(body);

async function customerOf(token: string, name = "شركة النيل") {
  return (await ok(await api().post("/api/customers").set(auth(token)).send({ name }), 201)).customer as { id: string };
}

const body = (customerId: string, extra: Record<string, unknown> = {}) => ({
  title: "عقد صيانة سنوي",
  customerId,
  value: "30,000",
  closeDate: addDays(today(), 30),
  notes: "",
  ...extra,
});

async function create(token: string, customerId: string, extra: Record<string, unknown> = {}) {
  return (await ok(await post(token, "", body(customerId, extra)), 201)).deal;
}

const list = async (token: string) => (await ok(await api().get("/api/deals").set(auth(token)))).deals as any[];

describe("adding deals", () => {
  it("a new deal starts as a lead, for a customer of the company", async () => {
    const { token, userId } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id, { ownerId: userId });
    expect(deal).toMatchObject({
      title: "عقد صيانة سنوي",
      value: "30000.00",
      stage: "lead",
      customer: "شركة النيل",
      ownerId: userId,
      owner: "محمد أحمد",
      lastActivityDaysAgo: 0,
      awaitingReply: false,
      lost: null,
      wonAt: null,
    });
    const { deals, staleDays, today: serverToday } = await ok(await api().get("/api/deals").set(auth(token)));
    expect(deals.map((d: { id: string }) => d.id)).toEqual([deal.id]);
    expect(staleDays).toBe(5);
    expect(serverToday).toBe(today());
  });

  it("refuses another company's customer or member, a zero value, and starting as won", async () => {
    const { token } = await ownerSession();
    const other = await ownerSession();
    const mine = await customerOf(token);
    const theirs = await customerOf(other.token);

    const wrongCustomer = await post(token, "", body(theirs.id));
    expect(wrongCustomer.body.error.code).toBe("INVALID_CUSTOMER");
    const wrongOwner = await post(token, "", body(mine.id, { ownerId: other.userId }));
    expect(wrongOwner.body.error.code).toBe("INVALID_ASSIGNEE");
    expect((await post(token, "", body(mine.id, { value: "0" }))).status).toBe(400);
    expect((await post(token, "", body(mine.id, { stage: "won" }))).status).toBe(400);
    expect(await prisma.deal.count()).toBe(0);
  });
});

describe("the pipeline", () => {
  it("moving to won closes it today; moving it back (undo) opens it again", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id, { stage: "negotiation", awaitingReply: true });
    // A week without activity.
    await prisma.deal.update({ where: { id: deal.id }, data: { lastActivityAt: new Date(Date.now() - 7 * 86_400_000) } });
    expect((await list(token))[0]).toMatchObject({ lastActivityDaysAgo: 7, awaitingReply: true });

    const won = (await ok(await post(token, `/${deal.id}/move`, { stage: "won" }))).deal;
    expect(won).toMatchObject({ stage: "won", closeDate: today(), lastActivityDaysAgo: 0, awaitingReply: false });
    expect(won.wonAt).not.toBeNull();

    const back = (await ok(await post(token, `/${deal.id}/move`, { stage: "negotiation" }))).deal;
    expect(back).toMatchObject({ stage: "negotiation", wonAt: null });
  });

  it("lost: keeps its stage, can't be moved or edited until reopened; a won deal can't be lost", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id, { stage: "proposal" });

    const lost = (await ok(await post(token, `/${deal.id}/lose`, { reason: "price", note: "طلب خصم أكبر" }))).deal;
    expect(lost).toMatchObject({ stage: "proposal", lost: { reason: "price", note: "طلب خصم أكبر", date: today() } });
    expect((await post(token, `/${deal.id}/lose`, { reason: "price" })).body.error.code).toBe("DEAL_NOT_OPEN");
    expect((await post(token, `/${deal.id}/move`, { stage: "won" })).body.error.code).toBe("DEAL_LOST");
    const edit = await api().patch(`/api/deals/${deal.id}`).set(auth(token)).send(body(customer.id));
    expect(edit.body.error.code).toBe("DEAL_LOST");

    const reopened = (await ok(await post(token, `/${deal.id}/reopen`))).deal;
    expect(reopened).toMatchObject({ stage: "proposal", lost: null });
    expect((await post(token, `/${deal.id}/reopen`)).body.error.code).toBe("DEAL_NOT_LOST");

    const other = await create(token, customer.id);
    await ok(await post(token, `/${other.id}/move`, { stage: "won" }));
    expect((await post(token, `/${other.id}/lose`, { reason: "other" })).body.error.code).toBe("DEAL_NOT_OPEN");
  });

  it("editing: a new stage counts as activity; a won deal stays won", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id, { awaitingReply: true });
    await prisma.deal.update({ where: { id: deal.id }, data: { lastActivityAt: new Date(Date.now() - 6 * 86_400_000) } });

    // Same stage: no activity, the flag stays.
    const same = (await ok(await api().patch(`/api/deals/${deal.id}`).set(auth(token)).send(body(customer.id, { value: "32000", awaitingReply: true })))).deal;
    expect(same).toMatchObject({ value: "32000.00", lastActivityDaysAgo: 6, awaitingReply: true });

    const moved = (await ok(await api().patch(`/api/deals/${deal.id}`).set(auth(token)).send(body(customer.id, { stage: "contacted" })))).deal;
    expect(moved).toMatchObject({ stage: "contacted", lastActivityDaysAgo: 0, awaitingReply: false });

    await ok(await post(token, `/${deal.id}/move`, { stage: "won" }));
    const wonEdit = (await ok(await api().patch(`/api/deals/${deal.id}`).set(auth(token)).send(body(customer.id, { stage: "lead", title: "عقد صيانة (معدل)" })))).deal;
    expect(wonEdit).toMatchObject({ stage: "won", title: "عقد صيانة (معدل)" });
  });

  it("a follow-up restarts the counter, can mark it as waiting, and clears today's follow-up date", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id, { followUpDate: today() });
    await prisma.deal.update({ where: { id: deal.id }, data: { lastActivityAt: new Date(Date.now() - 9 * 86_400_000) } });

    const touched = (await ok(await post(token, `/${deal.id}/touch`, { awaitingReply: true }))).deal;
    expect(touched).toMatchObject({ lastActivityDaysAgo: 0, awaitingReply: true, followUpDate: null });
  });

  it("won and lost deals older than 90 days leave the board", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const open = await create(token, customer.id, { title: "مفتوحة" });
    const oldWon = await create(token, customer.id, { title: "مكسبة قديمة" });
    const oldLost = await create(token, customer.id, { title: "خسرانة قديمة" });
    const recentWon = await create(token, customer.id, { title: "مكسبة جديدة" });
    const long = toDate(addDays(today(), -120));
    await prisma.deal.update({ where: { id: oldWon.id }, data: { stage: "won", closeDate: long, wonAt: long } });
    await prisma.deal.update({ where: { id: oldLost.id }, data: { lostOn: long, lostReason: "price" } });
    await ok(await post(token, `/${recentWon.id}/move`, { stage: "won" }));

    expect((await list(token)).map((d) => d.title).sort()).toEqual([open.title, recentWon.title].sort());
  });
});

describe("who can do what", () => {
  it("viewers read; sales work on deals; a won deal is deleted by the owner only", async () => {
    const { token } = await ownerSession();
    const viewer = await teamMember(token, "viewer");
    const sales = await teamMember(token, "sales");
    const customer = await customerOf(token);

    expect((await post(viewer.token, "", body(customer.id))).status).toBe(403);
    const deal = await create(sales.token, customer.id);
    expect((await list(viewer.token)).map((d) => d.id)).toEqual([deal.id]);

    const won = await create(sales.token, customer.id);
    await ok(await post(sales.token, `/${won.id}/move`, { stage: "won" }));
    expect((await api().delete(`/api/deals/${won.id}`).set(auth(sales.token))).status).toBe(403);
    expect((await api().delete(`/api/deals/${deal.id}`).set(auth(sales.token))).status).toBe(204);
    expect((await api().delete(`/api/deals/${won.id}`).set(auth(token))).status).toBe(204);
    expect(await prisma.deal.count()).toBe(0);
  });

  it("a company sees only its own deals; a customer's deals go with the customer", async () => {
    const one = await ownerSession();
    const two = await ownerSession();
    const customer = await customerOf(one.token);
    const deal = await create(one.token, customer.id);

    expect(await list(two.token)).toEqual([]);
    expect((await api().get(`/api/deals/${deal.id}`).set(auth(two.token))).status).toBe(404);
    expect((await post(two.token, `/${deal.id}/move`, { stage: "won" })).status).toBe(404);

    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(one.token))).status).toBe(204);
    expect(await prisma.deal.count()).toBe(0);
  });

  it("deals quiet for 5 days or more show on the dashboard (open ones only)", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const quiet = await create(token, customer.id, { title: "صفقة نايمة" });
    const fresh = await create(token, customer.id, { title: "صفقة جديدة" });
    const lostQuiet = await create(token, customer.id, { title: "صفقة خسرانة" });
    await ok(await post(token, `/${lostQuiet.id}/lose`, { reason: "noNeed" }));
    const old = new Date(Date.now() - 8 * 86_400_000);
    await prisma.deal.updateMany({ where: { id: { in: [quiet.id, lostQuiet.id] } }, data: { lastActivityAt: old } });

    const dashboard = await ok(await api().get("/api/dashboard").set(auth(token)));
    const deals = dashboard.attention.filter((a: { type: string }) => a.type === "staleDeal");
    expect(deals).toEqual([
      { type: "staleDeal", id: quiet.id, number: null, displayNumber: "صفقة نايمة", customer: "شركة النيل", amount: "30000.00", days: 8 },
    ]);
    expect(fresh.id).not.toBe(quiet.id);
  });

  it("tasks about a deal: its customer fills in, the deal counts open ones, the task outlives the deal", async () => {
    const { token } = await ownerSession();
    const other = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id);
    const theirDeal = await create(other.token, (await customerOf(other.token)).id);
    const task = (body: Record<string, unknown>) =>
      api().post("/api/tasks").set(auth(token)).send({ title: "اتصال متابعة", due: today(), ...body });

    const linked = (await ok(await task({ dealId: deal.id }), 201)).task;
    expect(linked).toMatchObject({ deal: { id: deal.id, title: "عقد صيانة سنوي" }, customer: { id: customer.id } });
    expect((await task({ dealId: theirDeal.id })).body.error.code).toBe("INVALID_DEAL");
    const done = (await ok(await task({ dealId: deal.id, title: "زيارة" }), 201)).task;
    await ok(await api().patch(`/api/tasks/${done.id}`).set(auth(token)).send({ done: true }));

    expect((await list(token))[0]).toMatchObject({ id: deal.id, openTasks: 1 });

    // Unlink, then link again from the task.
    const unlinked = (await ok(await api().patch(`/api/tasks/${linked.id}`).set(auth(token)).send({ dealId: null }))).task;
    expect(unlinked.deal).toBeNull();
    await ok(await api().patch(`/api/tasks/${linked.id}`).set(auth(token)).send({ dealId: deal.id }));

    expect((await api().delete(`/api/deals/${deal.id}`).set(auth(token))).status).toBe(204);
    const { items } = await ok(await api().get("/api/tasks").set(auth(token)));
    expect(items.find((t: { id: string }) => t.id === linked.id)).toMatchObject({ deal: null, customer: { id: customer.id } });
  });

  it("everything goes in the audit log", async () => {
    const { token } = await ownerSession();
    const customer = await customerOf(token);
    const deal = await create(token, customer.id);
    await ok(await post(token, `/${deal.id}/move`, { stage: "proposal" }));
    await ok(await post(token, `/${deal.id}/lose`, { reason: "competitor" }));
    await ok(await post(token, `/${deal.id}/reopen`));
    await ok(await post(token, `/${deal.id}/move`, { stage: "won" }));

    const { items } = await ok(await api().get("/api/audit?pageSize=100").set(auth(token)));
    const dealLines = items.filter((l: { item: { type: string } }) => l.item.type === "deal");
    expect(dealLines.map((l: { event: string }) => l.event)).toEqual([
      "dealWon",
      "dealReopened",
      "dealLost",
      "dealMoved",
      "dealCreated",
    ]);
    expect(dealLines[0]).toMatchObject({ item: { id: deal.id, ref: "عقد صيانة سنوي" }, values: { amount: "30000.00", from: "proposal" } });
  });
});
