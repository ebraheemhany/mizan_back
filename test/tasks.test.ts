import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, businessToday, toDate, toIso } from "../src/lib/dates.js";
import { DONE_VISIBLE_DAYS, LIST_LIMIT } from "../src/modules/tasks/tasks.service.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

const add = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post("/api/tasks")
    .set(auth(token))
    .send({ title: "متابعة عرض السعر", due: today(), ...body });

const patch = (token: string, id: string, body: Record<string, unknown>) =>
  api().patch(`/api/tasks/${id}`).set(auth(token)).send(body);

const remove = (token: string, id: string) => api().delete(`/api/tasks/${id}`).set(auth(token));

const list = async (token: string) => {
  const res = await api().get("/api/tasks").set(auth(token));
  expect(res.status).toBe(200);
  return res.body as { today: string; items: { id: string; title: string; customer: unknown; done: boolean }[] };
};

const titles = async (token: string) => (await list(token)).items.map((t) => t.title);

const newCustomer = async (token: string, name = "شركة النور") => {
  const res = await api().post("/api/customers").set(auth(token)).send({ name });
  expect(res.status).toBe(201);
  return res.body.customer as { id: string; name: string };
};

/** Marks a task done on a given day, straight in the database. */
const doneOn = (id: string, day: string) =>
  prisma.task.update({ where: { id }, data: { completedOn: toDate(day), completedAt: toDate(day) } });

describe("POST /api/tasks", () => {
  it("adds a task with the default priority and kind", async () => {
    const owner = await ownerSession();
    const res = await add(owner.token, { title: "  اتصال بالمحاسب  " });
    expect(res.status).toBe(201);
    expect(res.body.task).toEqual({
      id: expect.any(String),
      title: "اتصال بالمحاسب",
      due: today(),
      priority: "normal",
      kind: "admin",
      done: false,
      completedOn: null,
      customer: null,
      deal: null,
      createdBy: { id: owner.userId, fullName: "محمد أحمد" },
      createdAt: expect.any(String),
    });
    expect(new Date(res.body.task.createdAt).toISOString()).toBe(res.body.task.createdAt);
  });

  it("adds a task linked to a customer, with a priority and kind", async () => {
    const owner = await ownerSession();
    const customer = await newCustomer(owner.token);
    const res = await add(owner.token, {
      due: addDays(today(), 3),
      priority: "urgent",
      kind: "collection",
      customerId: customer.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      due: addDays(today(), 3),
      priority: "urgent",
      kind: "collection",
      customer: { id: customer.id, name: "شركة النور" },
    });
    // null is the same as no customer.
    expect((await add(owner.token, { customerId: null })).body.task.customer).toBeNull();
  });

  it("validates the input", async () => {
    const owner = await ownerSession();
    const bad: Record<string, unknown>[] = [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(201) },
      { title: 5 },
      { due: "2026-02-30" },
      { due: "20-11-2026" },
      { due: null },
      { priority: "high" },
      { kind: "call" },
      { customerId: "not-a-uuid" },
    ];
    for (const body of bad) {
      const res = await add(owner.token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code, JSON.stringify(body)).toBe("VALIDATION_ERROR");
    }
    expect(await prisma.task.count()).toBe(0);
    expect((await add(owner.token, { title: "x".repeat(200) })).status).toBe(201);
  });

  it("refuses a customer that isn't one of the company's", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirs = await newCustomer(other.token);
    for (const customerId of [theirs.id, randomUUID()]) {
      const res = await add(owner.token, { customerId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_CUSTOMER");
    }
    expect(await prisma.task.count()).toBe(0);
  });
});

describe("GET /api/tasks", () => {
  it("lists open tasks by due date, then tasks done in the last 60 days, most recent first", async () => {
    const owner = await ownerSession();
    const t = today();
    const ids: Record<string, string> = {};
    const make = async (title: string, due: string) => {
      ids[title] = (await add(owner.token, { title, due })).body.task.id;
    };

    await make("later", addDays(t, 5));
    await make("today-b", t);
    await make("today-a", t);
    await make("long overdue", addDays(t, -400));
    await make("next year", addDays(t, 400));
    // Same due date: the one created first comes first.
    await prisma.task.update({ where: { id: ids["today-a"]! }, data: { createdAt: new Date(Date.now() - 60_000) } });

    await make("done today", addDays(t, -3));
    await make("done today, created later", addDays(t, 10));
    await make("done yesterday", t);
    await make("done 60 days ago", t);
    await make("done 61 days ago", t);

    expect((await patch(owner.token, ids["done today"]!, { done: true })).status).toBe(200);
    expect((await patch(owner.token, ids["done today, created later"]!, { done: true })).status).toBe(200);
    await doneOn(ids["done yesterday"]!, addDays(t, -1));
    await doneOn(ids["done 60 days ago"]!, addDays(t, -DONE_VISIBLE_DAYS));
    await doneOn(ids["done 61 days ago"]!, addDays(t, -DONE_VISIBLE_DAYS - 1));

    const body = await list(owner.token);
    expect(body.today).toBe(t);
    expect(body.items.map((i) => i.title)).toEqual([
      "long overdue",
      "today-a",
      "today-b",
      "later",
      "next year",
      "done today, created later",
      "done today",
      "done yesterday",
      "done 60 days ago",
    ]);
    expect(body.items.map((i) => i.done)).toEqual([false, false, false, false, false, true, true, true, true]);
  });

  it("returns at most 1000 tasks, open ones first", async () => {
    const owner = await ownerSession();
    const due = toDate(today());
    await prisma.task.createMany({
      data: Array.from({ length: LIST_LIMIT }, (_, i) => ({ title: `open ${i}`, dueDate: due, companyId: owner.companyId })),
    });
    await prisma.task.create({
      data: { title: "done", dueDate: due, completedOn: due, completedAt: new Date(), companyId: owner.companyId },
    });

    const { items } = await list(owner.token);
    expect(items).toHaveLength(LIST_LIMIT);
    expect(items.every((i) => !i.done)).toBe(true);
  });

  it("every role can read the list", async () => {
    const owner = await ownerSession();
    await add(owner.token, { title: "مهمة" });
    for (const role of ["accountant", "sales", "viewer"]) {
      const member = await teamMember(owner.token, role);
      expect(await titles(member.token), role).toEqual(["مهمة"]);
    }
    expect((await api().get("/api/tasks")).status).toBe(401);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("changes any of the fields", async () => {
    const owner = await ownerSession();
    const customer = await newCustomer(owner.token);
    const task = (await add(owner.token)).body.task;

    const res = await patch(owner.token, task.id, {
      title: " زيارة العميل ",
      due: addDays(today(), 7),
      priority: "important",
      kind: "visit",
      customerId: customer.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      id: task.id,
      title: "زيارة العميل",
      due: addDays(today(), 7),
      priority: "important",
      kind: "visit",
      done: false,
      customer: { id: customer.id, name: customer.name },
    });

    // Only what is sent changes; null unlinks the customer.
    const unlinked = await patch(owner.token, task.id, { customerId: null });
    expect(unlinked.body.task).toMatchObject({ title: "زيارة العميل", priority: "important", customer: null });
  });

  it("marks a task done today, keeps the day when marked again, and reopens it", async () => {
    const owner = await ownerSession();
    const task = (await add(owner.token, { due: addDays(today(), -5) })).body.task;

    const done = await patch(owner.token, task.id, { done: true });
    expect(done.status).toBe(200);
    expect(done.body.task).toMatchObject({ done: true, completedOn: today() });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.completedAt).toBeInstanceOf(Date);

    // Already done: marking it done again keeps the original day and time.
    await doneOn(task.id, addDays(today(), -2));
    const before = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const again = await patch(owner.token, task.id, { done: true });
    expect(again.body.task).toMatchObject({ done: true, completedOn: addDays(today(), -2) });
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.completedAt).toEqual(before.completedAt);

    // Other fields can change together with "done" on a done task.
    const renamed = await patch(owner.token, task.id, { done: true, title: "تمت" });
    expect(renamed.body.task).toMatchObject({ title: "تمت", completedOn: addDays(today(), -2) });

    const reopened = await patch(owner.token, task.id, { done: false });
    expect(reopened.body.task).toMatchObject({ done: false, completedOn: null });
    const cleared = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(cleared.completedAt).toBeNull();
    expect(cleared.completedOn).toBeNull();
  });

  it("undoing a reopen puts back the day it was really done", async () => {
    const owner = await ownerSession();
    const task = (await add(owner.token)).body.task;
    const doneDay = addDays(today(), -10);

    const back = await patch(owner.token, task.id, { done: true, completedOn: doneDay });
    expect(back.status).toBe(200);
    expect(back.body.task).toMatchObject({ done: true, completedOn: doneDay });

    // Only with done: true, and never after today.
    expect((await patch(owner.token, task.id, { completedOn: doneDay })).status).toBe(400);
    expect((await patch(owner.token, task.id, { done: false, completedOn: doneDay })).status).toBe(400);
    expect((await patch(owner.token, task.id, { done: true, completedOn: addDays(today(), 1) })).status).toBe(400);
    expect((await patch(owner.token, task.id, { done: true, completedOn: "2026-02-30" })).status).toBe(400);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.completedOn && toIso(row.completedOn)).toBe(doneDay);
  });

  it("a customer deleted while linking gives INVALID_CUSTOMER, not a server error", async () => {
    const owner = await ownerSession();
    const customer = await newCustomer(owner.token);
    const task = (await add(owner.token)).body.task;
    // The check passes, then the customer disappears before the write: simulated by
    // deleting it and letting the check still find it.
    await prisma.customer.delete({ where: { id: customer.id } });
    const check = vi.spyOn(prisma.customer, "count").mockResolvedValue(1);
    try {
      for (const res of [
        await add(owner.token, { customerId: customer.id }),
        await patch(owner.token, task.id, { customerId: customer.id }),
      ]) {
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("INVALID_CUSTOMER");
      }
      expect(check).toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });

  it("validates the input", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirCustomer = await newCustomer(other.token);
    const task = (await add(owner.token)).body.task;

    const bad: Record<string, unknown>[] = [
      {},
      { unknown: 1 },
      { title: "" },
      { title: "x".repeat(201) },
      { due: "2026-02-30" },
      { priority: "low" },
      { kind: "email" },
      { done: "yes" },
      { done: null },
      { customerId: "abc" },
    ];
    for (const body of bad) {
      const res = await patch(owner.token, task.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const foreign = await patch(owner.token, task.id, { customerId: theirCustomer.id });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("INVALID_CUSTOMER");

    expect((await patch(owner.token, randomUUID(), { title: "x" })).status).toBe(404);
    expect((await patch(owner.token, "not-an-id", { title: "x" })).status).toBe(404);

    const unchanged = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(unchanged).toMatchObject({ title: "متابعة عرض السعر", customerId: null, priority: "normal" });
  });
});

describe("permissions", () => {
  it("owner, accountant and sales add and update tasks; a viewer can only read", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    for (const member of [owner, accountant, sales]) {
      const created = await add(member.token);
      expect(created.status).toBe(201);
      expect(created.body.task.createdBy.id).toBe(member.userId);
      expect((await patch(member.token, created.body.task.id, { done: true })).status).toBe(200);
    }

    const ownersTask = (await add(owner.token, { title: "للمالك" })).body.task;
    expect((await api().get("/api/tasks").set(auth(viewer.token))).status).toBe(200);
    expect((await add(viewer.token)).status).toBe(403);
    expect((await patch(viewer.token, ownersTask.id, { done: true })).status).toBe(403);
    expect((await remove(viewer.token, ownersTask.id)).status).toBe(403);
    expect(await prisma.task.count()).toBe(4);
  });

  it("deleting: the owner can delete any task, anyone else only the ones they added", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");

    const salesTask = (await add(sales.token)).body.task;
    const byOther = await remove(accountant.token, salesTask.id);
    expect(byOther.status).toBe(403);
    expect(byOther.body.error.code).toBe("FORBIDDEN");
    expect((await remove(sales.token, salesTask.id)).status).toBe(204);
    expect((await remove(sales.token, salesTask.id)).status).toBe(404);

    const ownersTask = (await add(owner.token)).body.task;
    expect((await remove(sales.token, ownersTask.id)).status).toBe(403);

    const accountantsTask = (await add(accountant.token)).body.task;
    expect((await remove(owner.token, accountantsTask.id)).status).toBe(204);
    expect((await remove(owner.token, ownersTask.id)).status).toBe(204);
    expect(await prisma.task.count()).toBe(0);
  });
});

describe("company isolation", () => {
  it("another company's tasks are never listed and can't be changed or deleted", async () => {
    const mine = await ownerSession();
    const theirs = await ownerSession();
    const their = (await add(theirs.token, { title: "مهمتهم" })).body.task;
    await add(mine.token, { title: "مهمتي" });

    expect(await titles(mine.token)).toEqual(["مهمتي"]);
    expect((await patch(mine.token, their.id, { title: "x", done: true })).status).toBe(404);
    expect((await remove(mine.token, their.id)).status).toBe(404);

    const row = await prisma.task.findUniqueOrThrow({ where: { id: their.id } });
    expect(row).toMatchObject({ title: "مهمتهم", completedOn: null });
    expect(await titles(theirs.token)).toEqual(["مهمتهم"]);
  });
});

describe("linked customer", () => {
  it("shows the customer's current name, and the task stays when the customer is deleted", async () => {
    const owner = await ownerSession();
    const customer = await newCustomer(owner.token, "اسم قديم");
    const task = (await add(owner.token, { customerId: customer.id })).body.task;

    await api().patch(`/api/customers/${customer.id}`).set(auth(owner.token)).send({ name: "اسم جديد" });
    expect((await list(owner.token)).items[0]!.customer).toEqual({ id: customer.id, name: "اسم جديد" });

    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(owner.token))).status).toBe(204);
    const { items } = await list(owner.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: task.id, customer: null });
  });
});
