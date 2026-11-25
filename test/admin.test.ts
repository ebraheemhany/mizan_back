import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addMonths, businessToday, toDate } from "../src/lib/dates.js";
import { api, auth, login, prisma, registerUser, resetDatabase, uniqueEmail } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const ADMIN_EMAIL = "admin@mizan.test";

async function adminToken() {
  await registerUser(ADMIN_EMAIL);
  return (await login(ADMIN_EMAIL)).accessToken;
}

/** A company and its owner; `plan` gives it a paid subscription. */
async function company(plan?: "pro" | "business", status: "active" | "pastDue" | "ended" = "active") {
  const { email, user } = await registerUser();
  const companyId = user.company.id as string;
  if (plan) {
    const today = businessToday();
    await prisma.subscription.create({
      data: { companyId, plan, status, currentPeriodStart: toDate(today), currentPeriodEnd: toDate(addMonths(today, 1)) },
    });
  }
  const session = await login(email);
  return { email, companyId, token: session.accessToken };
}

const get = (path: string, token?: string) => {
  const request = api().get(path);
  return token ? request.set(auth(token)) : request;
};

describe("who may open the admin pages", () => {
  it("needs a login", async () => {
    expect((await get("/api/admin/overview")).status).toBe(401);
  });

  it("is a plain 404 for everyone not listed in PLATFORM_ADMIN_EMAILS", async () => {
    const { token } = await company();
    for (const path of ["/api/admin/overview", "/api/admin/companies"]) {
      const res = await get(path, token);
      expect(res.status).toBe(404);
    }
  });

  it("tells the session who is an admin (listed emails, any case)", async () => {
    const token = await adminToken();
    expect((await get("/api/auth/me", token)).body.user.isPlatformAdmin).toBe(true);

    const other = await company();
    expect((await get("/api/auth/me", other.token)).body.user.isPlatformAdmin).toBe(false);
  });
});

describe("GET /api/admin/overview", () => {
  it("counts companies, plans and Mizan's own revenue", async () => {
    const token = await adminToken();
    const pro = await company("pro");
    await company("business", "pastDue");
    await company("pro", "ended");
    await prisma.billingPayment.create({
      data: { companyId: pro.companyId, kind: "subscribe", plan: "pro", amount: "299.00", status: "paid", paidAt: new Date() },
    });
    await prisma.billingPayment.create({
      data: { companyId: pro.companyId, kind: "renewal", plan: "pro", amount: "299.00", status: "failed" },
    });

    const res = await get("/api/admin/overview", token);
    expect(res.status).toBe(200);
    // The admin's own company counts too: 4 companies.
    expect(res.body.companies).toMatchObject({ total: 4, newThisMonth: 4, newLast7Days: 4, active7Days: 4, active30Days: 4 });
    expect(res.body.users).toBe(4);
    // An ended subscription is back on free; a renewal being retried still counts.
    expect(res.body.plans).toEqual({ free: 2, pro: 1, business: 1 });
    expect(res.body.subscriptions).toEqual({ paying: 2, pastDue: 1, cancelling: 0 });
    expect(res.body.revenue).toEqual({ currency: "EGP", monthlyRecurring: "1098.00", thisMonth: "299.00", total: "299.00" });
  });
});

describe("GET /api/admin/companies", () => {
  it("lists each company with its owner, plan and counts", async () => {
    const token = await adminToken();
    const pro = await company("pro");
    await api()
      .post("/api/customers")
      .set(auth(pro.token))
      .send({ name: "عميل" })
      .expect(201);

    const res = await get("/api/admin/companies", token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.counts).toEqual({ all: 2, free: 1, pro: 1, business: 0 });
    const row = res.body.companies.find((c: { id: string }) => c.id === pro.companyId);
    expect(row).toMatchObject({
      name: "شركة ميزان",
      owner: { email: pro.email, name: "محمد أحمد" },
      plan: "pro",
      subscription: { status: "active", cancelAtPeriodEnd: false },
      users: 1,
      customers: 1,
      invoices: 0,
      invoicesThisMonth: 0,
    });
    expect(row.lastActiveAt).toBeTruthy();
    // Nothing from inside the company beyond counts.
    expect(JSON.stringify(row)).not.toContain("عميل");
  });

  it("searches by company name or owner email, and filters by plan", async () => {
    const token = await adminToken();
    const pro = await company("pro");
    await prisma.company.update({ where: { id: pro.companyId }, data: { name: "Nile Trading 100%" } });
    await company();

    const byName = await get(`/api/admin/companies?q=${encodeURIComponent("nile trading 100%")}`, token);
    expect(byName.body.companies.map((c: { id: string }) => c.id)).toEqual([pro.companyId]);

    const byEmail = await get(`/api/admin/companies?q=${encodeURIComponent(pro.email.slice(0, 12))}`, token);
    expect(byEmail.body.companies.map((c: { id: string }) => c.id)).toContain(pro.companyId);

    // "%" is a character to find, not a wildcard.
    expect((await get("/api/admin/companies?q=%25%25", token)).body.total).toBe(0);

    const proOnly = await get("/api/admin/companies?plan=pro", token);
    expect(proOnly.body.companies.map((c: { id: string }) => c.id)).toEqual([pro.companyId]);
    expect((await get("/api/admin/companies?plan=free", token)).body.total).toBe(2);
    // The tab counts ignore the filters.
    expect(proOnly.body.counts.all).toBe(3);
  });

  it("sorts newest first by default, and by name", async () => {
    const token = await adminToken();
    const a = await company();
    await prisma.company.update({ where: { id: a.companyId }, data: { name: "Alpha" } });
    const b = await company();
    await prisma.company.update({ where: { id: b.companyId }, data: { name: "beta" } });

    const newest = await get("/api/admin/companies", token);
    expect(newest.body.companies[0].id).toBe(b.companyId);
    const byName = await get("/api/admin/companies?sort=name", token);
    expect(byName.body.companies.map((c: { name: string }) => c.name).slice(0, 2)).toEqual(["Alpha", "beta"]);
  });

  it("refuses unknown filters", async () => {
    const token = await adminToken();
    expect((await get("/api/admin/companies?plan=gold", token)).status).toBe(400);
  });
});

describe("GET /api/admin/companies/:id", () => {
  it("shows the company, its plan use, members, usage, activity and billing", async () => {
    const token = await adminToken();
    const pro = await company("pro");
    await prisma.billingPayment.create({
      data: { companyId: pro.companyId, kind: "subscribe", plan: "pro", amount: "299.00", status: "paid", paidAt: new Date() },
    });

    const res = await get(`/api/admin/companies/${pro.companyId}`, token);
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ id: pro.companyId, name: "شركة ميزان" });
    expect(res.body.plan).toMatchObject({ id: "pro", price: 299, users: { used: 1, limit: 10 }, invoicesThisMonth: { used: 0, limit: null } });
    expect(res.body.subscription).toMatchObject({ plan: "pro", status: "active", cancelAtPeriodEnd: false, card: null });
    expect(res.body.members).toEqual([
      expect.objectContaining({ email: pro.email, role: "owner", password: true, google: false, desktop: false }),
    ]);
    expect(res.body.members[0].lastActiveAt).toBeTruthy();
    expect(res.body.members[0]).not.toHaveProperty("passwordHash");
    expect(res.body.usage).toMatchObject({ customers: 0, invoices: 0, quotes: 0, employees: 0 });
    expect(res.body.activity.days).toHaveLength(30);
    expect(res.body.activity.days.at(-1).count).toBeGreaterThan(0);
    expect(res.body.billing).toEqual([expect.objectContaining({ kind: "subscribe", plan: "pro", amount: "299.00", status: "paid" })]);
    expect(res.body.billing[0].number).toMatch(/^SUB-\d{5}$/);
  });

  it("is 404 for an unknown company, and for non-admins", async () => {
    const token = await adminToken();
    expect((await get("/api/admin/companies/00000000-0000-0000-0000-000000000000", token)).status).toBe(404);
    expect((await get("/api/admin/companies/not-a-uuid", token)).status).toBe(404);

    const other = await company();
    expect((await get(`/api/admin/companies/${other.companyId}`, other.token)).status).toBe(404);
  });
});

it("an admin listed with another email is an admin too", async () => {
  const email = "other-admin@mizan.test";
  await registerUser(email);
  const { accessToken } = await login(email);
  expect((await get("/api/admin/overview", accessToken)).status).toBe(200);
  expect(uniqueEmail()).not.toBe(email);
});
