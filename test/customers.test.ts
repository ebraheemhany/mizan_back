import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { INACTIVE_AFTER_DAYS } from "../src/modules/customers/customers.service.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const DAY = 24 * 60 * 60 * 1000;

async function create(token: string, body: Record<string, unknown>) {
  const res = await api().post("/api/customers").set(auth(token)).send(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.customer as { id: string; name: string };
}

const list = (token: string, query = "") => api().get(`/api/customers${query}`).set(auth(token));

describe("POST /api/customers", () => {
  it("creates a customer and turns empty optional fields into null", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/customers")
      .set(auth(owner.token))
      .send({
        name: "  شركة النيل للتجارة ",
        contactName: "أحمد سمير",
        phone: "010 1234 5678",
        email: "info@alnile.example.com",
        city: "",
        taxNumber: "   ",
        assignedToId: owner.userId,
      });

    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({
      name: "شركة النيل للتجارة",
      contactName: "أحمد سمير",
      phone: "010 1234 5678",
      city: null,
      taxNumber: null,
      notes: null,
      balance: "0.00",
      status: "active",
      assignedTo: { id: owner.userId },
    });
  });

  it("validates the fields", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/customers")
      .set(auth(owner.token))
      .send({ name: "", phone: "abc", email: "not-an-email", notes: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details.fieldErrors).sort()).toEqual(["email", "name", "notes", "phone"]);
  });

  it("only accepts an assignee from the same company", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();

    for (const assignedToId of [other.userId, randomUUID()]) {
      const res = await api().post("/api/customers").set(auth(owner.token)).send({ name: "X", assignedToId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_ASSIGNEE");
    }
  });
});

describe("permissions by role", () => {
  it("everyone can view; owner and sales can edit; only the owner can delete", async () => {
    const owner = await ownerSession();
    const customer = await create(owner.token, { name: "عميل" });
    const sales = await teamMember(owner.token, "sales");
    const accountant = await teamMember(owner.token, "accountant");
    const viewer = await teamMember(owner.token, "viewer");

    // View: all four roles.
    for (const { token } of [owner, sales, accountant, viewer]) {
      expect((await list(token)).status).toBe(200);
      expect((await api().get(`/api/customers/${customer.id}`).set(auth(token))).status).toBe(200);
    }

    // Create / edit: owner and sales.
    const expectations: [string, number][] = [
      [owner.token, 201],
      [sales.token, 201],
      [accountant.token, 403],
      [viewer.token, 403],
    ];
    for (const [token, status] of expectations) {
      expect((await api().post("/api/customers").set(auth(token)).send({ name: "جديد" })).status).toBe(status);
      const patch = await api().patch(`/api/customers/${customer.id}`).set(auth(token)).send({ city: "طنطا" });
      expect(patch.status).toBe(status === 201 ? 200 : 403);
    }

    // Delete: owner only.
    for (const { token } of [sales, accountant, viewer]) {
      expect((await api().delete(`/api/customers/${customer.id}`).set(auth(token))).status).toBe(403);
      expect((await api().post("/api/customers/bulk-delete").set(auth(token)).send({ ids: [customer.id] })).status).toBe(403);
    }
    expect((await api().delete(`/api/customers/${customer.id}`).set(auth(owner.token))).status).toBe(204);
  });

  it("requires a login", async () => {
    expect((await api().get("/api/customers")).status).toBe(401);
  });
});

describe("company isolation", () => {
  it("never shows, edits or deletes another company's customers", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirs = await create(other.token, { name: "عميل شركة تانية" });
    await create(owner.token, { name: "عميلي" });

    const mine = await list(owner.token);
    expect(mine.body.items.map((c: { name: string }) => c.name)).toEqual(["عميلي"]);
    expect(mine.body.counts.all).toBe(1);

    expect((await api().get(`/api/customers/${theirs.id}`).set(auth(owner.token))).status).toBe(404);
    expect((await api().patch(`/api/customers/${theirs.id}`).set(auth(owner.token)).send({ name: "x" })).status).toBe(404);
    expect((await api().delete(`/api/customers/${theirs.id}`).set(auth(owner.token))).status).toBe(404);

    const bulk = await api().post("/api/customers/bulk-delete").set(auth(owner.token)).send({ ids: [theirs.id] });
    expect(bulk.body.deleted).toBe(0);
    const assign = await api()
      .post("/api/customers/bulk-assign")
      .set(auth(owner.token))
      .send({ ids: [theirs.id], assignedToId: owner.userId });
    expect(assign.body.updated).toBe(0);

    const untouched = await prisma.customer.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(untouched.name).toBe("عميل شركة تانية");
    expect(untouched.assignedToId).toBeNull();
  });
});

describe("GET /api/customers (list)", () => {
  async function seed() {
    const owner = await ownerSession();
    const sales = await teamMember(owner.token, "sales");
    const a = await create(owner.token, { name: "Alpha Trading", contactName: "Mona", email: "a@x.com", assignedToId: sales.userId });
    const b = await create(owner.token, { name: "Beta Clinic", phone: "010 5555 1234" });
    const c = await create(owner.token, { name: "Gamma Bakery", assignedToId: owner.userId });
    // Make the dates and balances differ.
    await prisma.customer.update({ where: { id: a.id }, data: { lastActivityAt: new Date(Date.now() - 1 * DAY), balance: "8200.50" } });
    await prisma.customer.update({ where: { id: b.id }, data: { lastActivityAt: new Date(Date.now() - 5 * DAY) } });
    await prisma.customer.update({
      where: { id: c.id },
      data: { lastActivityAt: new Date(Date.now() - (INACTIVE_AFTER_DAYS + 1) * DAY), balance: "300" },
    });
    return { owner, sales, a, b, c };
  }

  const names = (res: { body: { items: { name: string }[] } }) => res.body.items.map((c) => c.name);

  it("sorts by recent activity by default, and by oldest, balance or name", async () => {
    const { owner } = await seed();
    expect(names(await list(owner.token))).toEqual(["Alpha Trading", "Beta Clinic", "Gamma Bakery"]);
    expect(names(await list(owner.token, "?sort=oldest"))).toEqual(["Gamma Bakery", "Beta Clinic", "Alpha Trading"]);
    expect(names(await list(owner.token, "?sort=balance"))).toEqual(["Alpha Trading", "Gamma Bakery", "Beta Clinic"]);
    expect(names(await list(owner.token, "?sort=name"))).toEqual(["Alpha Trading", "Beta Clinic", "Gamma Bakery"]);
  });

  it("returns money as a 2-decimal string and a status from last activity", async () => {
    const { owner } = await seed();
    const res = await list(owner.token);
    const byName = Object.fromEntries(res.body.items.map((c: { name: string }) => [c.name, c]));
    expect(byName["Alpha Trading"]).toMatchObject({ balance: "8200.50", status: "active" });
    expect(byName["Gamma Bakery"]).toMatchObject({ balance: "300.00", status: "inactive" });
    expect(res.body.counts).toEqual({ all: 3, active: 2, inactive: 1, overdue: 0 });
  });

  it("searches name, contact, phone and email, ignoring case", async () => {
    const { owner } = await seed();
    expect(names(await list(owner.token, "?q=alpha"))).toEqual(["Alpha Trading"]);
    expect(names(await list(owner.token, "?q=MONA"))).toEqual(["Alpha Trading"]);
    expect(names(await list(owner.token, "?q=5555"))).toEqual(["Beta Clinic"]);
    expect(names(await list(owner.token, "?q=a%40x.com"))).toEqual(["Alpha Trading"]);
  });

  it("filters by status, assignee and balance; tab counts ignore the filters", async () => {
    const { owner, sales } = await seed();
    expect(names(await list(owner.token, "?status=inactive"))).toEqual(["Gamma Bakery"]);
    expect(names(await list(owner.token, "?status=overdue"))).toEqual([]);
    expect(names(await list(owner.token, `?assignedTo=${sales.userId}`))).toEqual(["Alpha Trading"]);
    expect(names(await list(owner.token, "?assignedTo=none"))).toEqual(["Beta Clinic"]);
    expect(names(await list(owner.token, "?balance=due&sort=name"))).toEqual(["Alpha Trading", "Gamma Bakery"]);
    expect(names(await list(owner.token, "?balance=zero"))).toEqual(["Beta Clinic"]);

    const filtered = await list(owner.token, "?q=alpha");
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.counts.all).toBe(3);
  });

  it("pages through the results", async () => {
    const owner = await ownerSession();
    for (let i = 1; i <= 15; i++) await create(owner.token, { name: `Customer ${String(i).padStart(2, "0")}` });

    const page1 = await list(owner.token, "?sort=name&pageSize=7");
    const page3 = await list(owner.token, "?sort=name&pageSize=7&page=3");
    expect(page1.body).toMatchObject({ total: 15, page: 1, pageSize: 7 });
    expect(names(page1)).toHaveLength(7);
    expect(names(page1)[0]).toBe("Customer 01");
    expect(names(page3)).toEqual(["Customer 15"]);
  });

  it("rejects bad query parameters", async () => {
    const owner = await ownerSession();
    for (const query of ["?sort=price", "?status=gone", "?pageSize=1000", "?page=0", "?assignedTo=bob"]) {
      expect((await list(owner.token, query)).status).toBe(400);
    }
  });
});

describe("GET /api/customers/export", () => {
  it("returns every matching customer, not just one page", async () => {
    const owner = await ownerSession();
    for (let i = 1; i <= 25; i++) await create(owner.token, { name: `C${i}` });
    const res = await api().get("/api/customers/export?pageSize=5&q=C1").set(auth(owner.token));
    expect(res.status).toBe(200);
    // C1, C10..C19 = 11 customers, more than pageSize.
    expect(res.body.items).toHaveLength(11);
  });
});

describe("PATCH /api/customers/:id", () => {
  it("changes only the fields sent, clears fields sent empty, and counts as activity", async () => {
    const owner = await ownerSession();
    const customer = await create(owner.token, { name: "Old", city: "Cairo", phone: "0100 000 0000" });
    await prisma.customer.update({ where: { id: customer.id }, data: { lastActivityAt: new Date(Date.now() - 30 * DAY) } });

    const res = await api().patch(`/api/customers/${customer.id}`).set(auth(owner.token)).send({ name: "New", city: "" });
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ name: "New", city: null, phone: "0100 000 0000" });
    expect(Date.now() - new Date(res.body.customer.lastActivityAt).getTime()).toBeLessThan(60_000);
  });

  it("can assign and unassign", async () => {
    const owner = await ownerSession();
    const customer = await create(owner.token, { name: "X", assignedToId: owner.userId });
    const res = await api().patch(`/api/customers/${customer.id}`).set(auth(owner.token)).send({ assignedToId: null });
    expect(res.body.customer.assignedTo).toBeNull();
  });
});

describe("bulk actions", () => {
  it("assigns and deletes many customers at once", async () => {
    const owner = await ownerSession();
    const sales = await teamMember(owner.token, "sales");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await create(owner.token, { name: `C${i}` })).id);

    const assign = await api()
      .post("/api/customers/bulk-assign")
      .set(auth(owner.token))
      .send({ ids: ids.slice(0, 3), assignedToId: sales.userId });
    expect(assign.body.updated).toBe(3);
    expect(await prisma.customer.count({ where: { assignedToId: sales.userId } })).toBe(3);

    const del = await api().post("/api/customers/bulk-delete").set(auth(owner.token)).send({ ids: ids.slice(0, 2) });
    expect(del.body.deleted).toBe(2);
    expect(await prisma.customer.count()).toBe(2);
  });

  it("rejects an assignee from another company", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const { id } = await create(owner.token, { name: "X" });
    const res = await api()
      .post("/api/customers/bulk-assign")
      .set(auth(owner.token))
      .send({ ids: [id], assignedToId: other.userId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_ASSIGNEE");
  });
});

describe("POST /api/customers/import", () => {
  it("creates all rows", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/customers/import")
      .set(auth(owner.token))
      .send({ customers: [{ name: "A", email: "a@x.com" }, { name: "B", phone: "" }, { name: "C" }] });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(await prisma.customer.count({ where: { companyId: owner.companyId } })).toBe(3);
  });

  it("saves nothing if any row is invalid, and says which rows", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/customers/import")
      .set(auth(owner.token))
      .send({ customers: [{ name: "Good" }, { name: "" }, { name: "Bad mail", email: "nope" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPORT_INVALID_ROWS");
    expect(res.body.error.details.rows.map((r: { row: number }) => r.row)).toEqual([2, 3]);
    expect(await prisma.customer.count()).toBe(0);
  });
});

describe("GET /api/team-members", () => {
  it("lists this company's members for any role, without emails", async () => {
    const owner = await ownerSession();
    const viewer = await teamMember(owner.token, "viewer");
    await ownerSession(); // another company

    const res = await api().get("/api/team-members").set(auth(viewer.token));
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).not.toHaveProperty("email");
  });
});

describe("when a team member is removed", () => {
  it("their customers stay, just unassigned", async () => {
    const owner = await ownerSession();
    const sales = await teamMember(owner.token, "sales");
    const customer = await create(owner.token, { name: "X", assignedToId: sales.userId });

    await api().delete(`/api/users/${sales.userId}`).set(auth(owner.token));

    const after = await api().get(`/api/customers/${customer.id}`).set(auth(owner.token));
    expect(after.status).toBe(200);
    expect(after.body.customer.assignedTo).toBeNull();
  });
});
