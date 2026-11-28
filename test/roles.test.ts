import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, ownerSession, PASSWORD, login, prisma, resetDatabase, teamMember, uniqueEmail } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const createRole = (token: string, body: Record<string, unknown>) => api().post("/api/roles").set(auth(token)).send(body);
const assign = (token: string, userId: string, body: Record<string, unknown>) =>
  api().patch(`/api/users/${userId}`).set(auth(token)).send(body);
const me = async (token: string) => (await api().get("/api/auth/me").set(auth(token))).body.user;

describe("/api/roles (the owner's own roles)", () => {
  it("creates, lists, renames and changes a role; permissions are kept in order, each once", async () => {
    const owner = await ownerSession();
    const res = await createRole(owner.token, { name: "أمين خزنة", permissions: ["recordPayments", "expenses", "recordPayments"] });
    expect(res.status).toBe(201);
    expect(res.body.role).toMatchObject({ name: "أمين خزنة", permissions: ["recordPayments", "expenses"], members: 0, pendingInvitations: 0 });

    const list = await api().get("/api/roles").set(auth(owner.token));
    expect(list.body.roles.map((r: { name: string }) => r.name)).toEqual(["أمين خزنة"]);

    const id = res.body.role.id;
    const renamed = await api().patch(`/api/roles/${id}`).set(auth(owner.token)).send({ name: "الخزنة", permissions: ["expenses"] });
    expect(renamed.status).toBe(200);
    expect(renamed.body.role).toMatchObject({ name: "الخزنة", permissions: ["expenses"] });

    const events = await prisma.auditEvent.findMany({ where: { companyId: owner.companyId, event: { in: ["roleCreated", "roleUpdated"] } } });
    expect(events.map((e) => e.event).sort()).toEqual(["roleCreated", "roleUpdated"]);
  });

  it("checks names and permissions, and is for the owner only", async () => {
    const owner = await ownerSession();
    for (const body of [
      { name: "", permissions: ["expenses"] },
      { name: "x", permissions: [] },
      { name: "x", permissions: ["flyToTheMoon"] },
    ]) {
      expect((await createRole(owner.token, body)).status).toBe(400);
    }
    expect((await createRole(owner.token, { name: "مندوب", permissions: ["quotes"] })).status).toBe(201);
    const twice = await createRole(owner.token, { name: "مندوب", permissions: ["deals"] });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("ROLE_NAME_TAKEN");

    const accountant = await teamMember(owner.token, "accountant");
    expect((await api().get("/api/roles").set(auth(accountant.token))).status).toBe(403);
    expect((await createRole(accountant.token, { name: "y", permissions: ["quotes"] })).status).toBe(403);
  });
});

describe("a member with a custom role", () => {
  it("can do exactly what the role allows, and a change applies on the next request", async () => {
    const owner = await ownerSession();
    const role = (await createRole(owner.token, { name: "أمين خزنة", permissions: ["expenses", "viewCustomers"] })).body.role;
    const member = await teamMember(owner.token, "viewer");

    const res = await assign(owner.token, member.userId, { role: "custom", customRoleId: role.id });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: "custom", customRole: { id: role.id, name: "أمين خزنة" } });

    // The same access token: the server reads the role on every request.
    expect(await me(member.token)).toMatchObject({ role: "custom", customRole: { name: "أمين خزنة" }, permissions: ["viewCustomers", "expenses"] });
    expect((await api().get("/api/expenses").set(auth(member.token))).status).toBe(200);
    // Not in the role: products are for editProducts.
    expect((await api().post("/api/products").set(auth(member.token)).send({ name: "منتج", price: "10" })).status).toBe(403);

    // Taking "expenses" away closes it at once.
    await api().patch(`/api/roles/${role.id}`).set(auth(owner.token)).send({ permissions: ["viewCustomers"] }).expect(200);
    expect((await api().get("/api/expenses").set(auth(member.token))).status).toBe(403);

    // The log names the custom role.
    const changed = await prisma.auditEvent.findFirst({ where: { companyId: owner.companyId, event: "roleChanged" } });
    expect(changed?.values).toMatchObject({ from: "viewer", role: "أمين خزنة" });
  });

  it("back to a built-in role drops the custom one", async () => {
    const owner = await ownerSession();
    const role = (await createRole(owner.token, { name: "مندوب", permissions: ["quotes"] })).body.role;
    const member = await teamMember(owner.token, "viewer");
    await assign(owner.token, member.userId, { role: "custom", customRoleId: role.id }).expect(200);
    const back = await assign(owner.token, member.userId, { role: "sales" });
    expect(back.body.user).toMatchObject({ role: "sales", customRole: null });
    expect((await me(member.token)).permissions).toContain("editCustomers");
  });

  it("refuses a custom role without its id, an id with a built-in role, and another company's role", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirs = (await createRole(other.token, { name: "غريب", permissions: ["quotes"] })).body.role;
    const ours = (await createRole(owner.token, { name: "مندوب", permissions: ["quotes"] })).body.role;
    const member = await teamMember(owner.token, "viewer");

    expect((await assign(owner.token, member.userId, { role: "custom" })).status).toBe(400);
    expect((await assign(owner.token, member.userId, { role: "sales", customRoleId: ours.id })).status).toBe(400);
    expect((await assign(owner.token, member.userId, { role: "custom", customRoleId: theirs.id })).status).toBe(404);
  });
});

describe("inviting with a custom role", () => {
  it("the invitation shows the role's name, and the person joins with it", async () => {
    const owner = await ownerSession();
    const role = (await createRole(owner.token, { name: "مدخل بيانات", permissions: ["editCustomers", "viewCustomers"] })).body.role;
    const email = uniqueEmail();
    const sent = await api()
      .post("/api/invitations")
      .set(auth(owner.token))
      .send({ name: "Sara Ali", email, role: "custom", customRoleId: role.id });
    expect(sent.status).toBe(201);
    expect(sent.body.invitation).toMatchObject({ role: "custom", customRole: { id: role.id, name: "مدخل بيانات" } });
    const token = new URL(sent.body.inviteUrl).pathname.split("/").pop()!;

    const preview = await api().post("/api/invitations/preview").send({ token });
    expect(preview.body.invitation).toMatchObject({ role: "custom", customRole: { name: "مدخل بيانات" } });

    // The role can't go while the invitation waits.
    const blocked = await api().delete(`/api/roles/${role.id}`).set(auth(owner.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "ROLE_IN_USE", details: { members: 0, invitations: 1 } });

    await api().post("/api/invitations/accept").send({ token, password: PASSWORD }).expect(201);
    const session = await login(email);
    expect(await me(session.accessToken)).toMatchObject({ role: "custom", customRole: { name: "مدخل بيانات" }, permissions: ["viewCustomers", "editCustomers"] });
    expect(sent.body.invitation.customRole).toBeTruthy();
  });

  it("a role in use can't be deleted; once nobody has it, it can", async () => {
    const owner = await ownerSession();
    const role = (await createRole(owner.token, { name: "مؤقت", permissions: ["tasks"] })).body.role;
    const member = await teamMember(owner.token, "viewer");
    await assign(owner.token, member.userId, { role: "custom", customRoleId: role.id }).expect(200);

    const inUse = await api().delete(`/api/roles/${role.id}`).set(auth(owner.token));
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.details).toMatchObject({ members: 1 });

    await assign(owner.token, member.userId, { role: "viewer" }).expect(200);
    await api().delete(`/api/roles/${role.id}`).set(auth(owner.token)).expect(204);
    expect(await prisma.companyRole.count({ where: { companyId: owner.companyId } })).toBe(0);
  });

  it("deleting the whole company takes its roles and the members who had them", async () => {
    const owner = await ownerSession();
    const role = (await createRole(owner.token, { name: "مؤقت", permissions: ["tasks"] })).body.role;
    const member = await teamMember(owner.token, "viewer");
    await assign(owner.token, member.userId, { role: "custom", customRoleId: role.id }).expect(200);

    await prisma.company.delete({ where: { id: owner.companyId } });
    expect(await prisma.companyRole.count({ where: { id: role.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: member.userId } })).toBe(0);
  });
});
