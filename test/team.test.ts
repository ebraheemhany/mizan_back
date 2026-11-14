import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  PASSWORD,
  api,
  auth,
  hashToken,
  invite,
  login,
  ownerSession,
  prisma,
  registerUser,
  resetDatabase,
  teamMember,
  uniqueEmail,
} from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

describe("POST /api/invitations (create)", () => {
  it("lets the owner invite someone and returns a one-time link", async () => {
    const owner = await ownerSession();
    const email = uniqueEmail();
    const res = await api()
      .post("/api/invitations")
      .set(auth(owner.token))
      .send({ name: "Sara Ali", email: email.toUpperCase(), role: "sales" });

    expect(res.status).toBe(201);
    expect(res.body.invitation).toMatchObject({ email, name: "Sara Ali", role: "sales", invitedBy: { id: owner.userId } });
    expect(res.body.inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[\w-]{43}$/);

    // Only the hash is stored, and the token is not in the response anywhere else.
    const token = new URL(res.body.inviteUrl).pathname.split("/").pop()!;
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: res.body.invitation.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(res.body.invitation)).not.toContain(token);

    // The link expires in 7 days.
    const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it("is owner-only", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");

    const asAccountant = await api()
      .post("/api/invitations")
      .set(auth(accountant.token))
      .send({ name: "X", email: uniqueEmail(), role: "viewer" });
    expect(asAccountant.status).toBe(403);
    expect(asAccountant.body.error.code).toBe("FORBIDDEN");

    const anonymous = await api().post("/api/invitations").send({ name: "X", email: uniqueEmail(), role: "viewer" });
    expect(anonymous.status).toBe(401);
  });

  it("cannot invite someone as owner", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/invitations")
      .set(auth(owner.token))
      .send({ name: "X", email: uniqueEmail(), role: "owner" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors.role).toBeDefined();
  });

  it("refuses an email that already has an account", async () => {
    const owner = await ownerSession();
    const existing = await registerUser();
    const res = await api()
      .post("/api/invitations")
      .set(auth(owner.token))
      .send({ name: "X", email: existing.email, role: "viewer" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("inviting the same email again replaces the old link", async () => {
    const owner = await ownerSession();
    const first = await invite(owner.token, "viewer");
    const second = await invite(owner.token, "sales", first.email);

    expect((await api().post("/api/invitations/preview").send({ token: first.token })).status).toBe(400);
    const preview = await api().post("/api/invitations/preview").send({ token: second.token });
    expect(preview.status).toBe(200);
    expect(preview.body.invitation.role).toBe("sales");
  });
});

describe("GET /api/invitations and DELETE /api/invitations/:id", () => {
  it("lists only this company's pending invites", async () => {
    const owner = await ownerSession();
    const otherOwner = await ownerSession();
    const pendingInvite = await invite(owner.token, "viewer");
    await teamMember(owner.token, "sales"); // accepted: not pending
    const revoked = await invite(owner.token, "viewer");
    await api().delete(`/api/invitations/${revoked.invitation.id}`).set(auth(owner.token));
    const expired = await invite(owner.token, "viewer");
    await prisma.invitation.update({ where: { id: expired.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await invite(otherOwner.token, "viewer"); // other company

    const res = await api().get("/api/invitations").set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.invitations.map((i: { email: string }) => i.email)).toEqual([pendingInvite.email]);
  });

  it("revoking an invite kills its link", async () => {
    const owner = await ownerSession();
    const { token, invitation } = await invite(owner.token);

    expect((await api().delete(`/api/invitations/${invitation.id}`).set(auth(owner.token))).status).toBe(204);
    const accept = await api().post("/api/invitations/accept").send({ token, password: PASSWORD });
    expect(accept.status).toBe(400);
    expect(accept.body.error.code).toBe("INVALID_INVITATION");
  });

  it("cannot revoke another company's invite, or a bad id", async () => {
    const owner = await ownerSession();
    const otherOwner = await ownerSession();
    const { invitation } = await invite(otherOwner.token);

    expect((await api().delete(`/api/invitations/${invitation.id}`).set(auth(owner.token))).status).toBe(404);
    expect((await api().delete(`/api/invitations/not-a-uuid`).set(auth(owner.token))).status).toBe(404);
    // Still alive for its own company.
    expect((await api().get("/api/invitations").set(auth(otherOwner.token))).body.invitations).toHaveLength(1);
  });
});

describe("POST /api/invitations/preview", () => {
  it("shows the company, role and name to the invited person", async () => {
    const owner = await ownerSession();
    const { token, email } = await invite(owner.token, "sales");

    const res = await api().post("/api/invitations/preview").send({ token });
    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ email, name: "Sara Ali", role: "sales", company: { name: "شركة ميزان" } });
    expect(res.body.invitation).not.toHaveProperty("tokenHash");
  });

  it("rejects an unknown or expired link", async () => {
    const owner = await ownerSession();
    const { token, invitation } = await invite(owner.token);
    await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    for (const t of [token, "never-issued"]) {
      const res = await api().post("/api/invitations/preview").send({ token: t });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_INVITATION");
    }
  });
});

describe("POST /api/invitations/accept", () => {
  it("creates the user in the inviting company with the invited role", async () => {
    const owner = await ownerSession();
    const { token, email } = await invite(owner.token, "sales");

    const res = await api().post("/api/invitations/accept").send({ token, password: PASSWORD, fullName: "Sara M. Ali" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, fullName: "Sara M. Ali", role: "sales", company: { id: owner.companyId } });
    expect(res.body).not.toHaveProperty("accessToken");

    // They can log in with the password they chose.
    const session = await login(email);
    const me = await api().get("/api/auth/me").set(auth(session.accessToken));
    expect(me.body.user).toMatchObject({ role: "sales", company: { id: owner.companyId } });
  });

  it("uses the name from the invite when none is given", async () => {
    const owner = await ownerSession();
    const { token } = await invite(owner.token);
    const res = await api().post("/api/invitations/accept").send({ token, password: PASSWORD });
    expect(res.body.user.fullName).toBe("Sara Ali");
  });

  it("works only once", async () => {
    const owner = await ownerSession();
    const { token } = await invite(owner.token);

    expect((await api().post("/api/invitations/accept").send({ token, password: PASSWORD })).status).toBe(201);
    const again = await api().post("/api/invitations/accept").send({ token, password: "Another123!" });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_INVITATION");
  });

  it("lets only one of two simultaneous accepts succeed", async () => {
    const owner = await ownerSession();
    const { token } = await invite(owner.token);

    const results = await Promise.all([
      api().post("/api/invitations/accept").send({ token, password: PASSWORD }),
      api().post("/api/invitations/accept").send({ token, password: PASSWORD }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await prisma.user.count({ where: { companyId: owner.companyId } })).toBe(2);
  });

  it("rejects an expired link and a short password", async () => {
    const owner = await ownerSession();
    const { token, invitation } = await invite(owner.token);

    const short = await api().post("/api/invitations/accept").send({ token, password: "123" });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("VALIDATION_ERROR");

    await prisma.invitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post("/api/invitations/accept").send({ token, password: PASSWORD })).status).toBe(400);
  });

  it("refuses if the email got an account after the invite, and keeps the invite pending", async () => {
    const owner = await ownerSession();
    const { token, email, invitation } = await invite(owner.token);
    await registerUser(email); // signed up on their own in the meantime

    const res = await api().post("/api/invitations/accept").send({ token, password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.acceptedAt).toBeNull();
  });
});

describe("GET /api/users", () => {
  it("lists only this company's team, without secrets", async () => {
    const owner = await ownerSession();
    const member = await teamMember(owner.token, "viewer");
    await ownerSession(); // another company

    const res = await api().get("/api/users").set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { id: string; role: string }) => [u.id, u.role])).toEqual([
      [owner.userId, "owner"],
      [member.userId, "viewer"],
    ]);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("is owner-only", async () => {
    const owner = await ownerSession();
    for (const role of ["accountant", "sales", "viewer"]) {
      const member = await teamMember(owner.token, role);
      expect((await api().get("/api/users").set(auth(member.token))).status).toBe(403);
    }
  });
});

describe("PATCH /api/users/:id", () => {
  it("changes a member's role, effective on their very next request", async () => {
    const owner = await ownerSession();
    const member = await teamMember(owner.token, "viewer");

    const res = await api().patch(`/api/users/${member.userId}`).set(auth(owner.token)).send({ role: "accountant" });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("accountant");

    // Same access token, new role.
    expect((await api().get("/api/auth/me").set(auth(member.token))).body.user.role).toBe("accountant");
  });

  it("promoting to owner is not possible", async () => {
    const owner = await ownerSession();
    const member = await teamMember(owner.token);
    const res = await api().patch(`/api/users/${member.userId}`).set(auth(owner.token)).send({ role: "owner" });
    expect(res.status).toBe(400);
  });

  it("cannot change the owner (including yourself)", async () => {
    const owner = await ownerSession();
    const res = await api().patch(`/api/users/${owner.userId}`).set(auth(owner.token)).send({ role: "viewer" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CANNOT_MODIFY_OWNER");
  });

  it("cannot touch users of another company", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const outsider = await teamMember(other.token, "viewer");

    for (const id of [outsider.userId, other.userId, randomUUID(), "nope"]) {
      const res = await api().patch(`/api/users/${id}`).set(auth(owner.token)).send({ role: "accountant" });
      expect(res.status).toBe(404);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: outsider.userId } })).role).toBe("viewer");
  });
});

describe("DELETE /api/users/:id", () => {
  it("removes a member and ends all their sessions immediately", async () => {
    const owner = await ownerSession();
    const member = await teamMember(owner.token);

    expect((await api().delete(`/api/users/${member.userId}`).set(auth(owner.token))).status).toBe(204);

    expect((await api().get("/api/auth/me").set(auth(member.token))).status).toBe(401);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: member.refreshToken })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: member.email, password: PASSWORD })).status).toBe(401);
  });

  it("keeps invites the removed member had sent", async () => {
    // Members cannot invite today, but the schema keeps an invite if its sender is deleted.
    const owner = await ownerSession();
    const member = await teamMember(owner.token);
    const { invitation } = await invite(owner.token);
    await prisma.invitation.update({ where: { id: invitation.id }, data: { invitedById: member.userId } });

    await api().delete(`/api/users/${member.userId}`).set(auth(owner.token));
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.invitedById).toBeNull();
  });

  it("cannot remove the owner or another company's user", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();

    const self = await api().delete(`/api/users/${owner.userId}`).set(auth(owner.token));
    expect(self.status).toBe(403);
    expect((await api().delete(`/api/users/${other.userId}`).set(auth(owner.token))).status).toBe(404);
    expect(await prisma.user.count()).toBe(2);
  });
});
