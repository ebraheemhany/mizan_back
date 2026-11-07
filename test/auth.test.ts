import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASSWORD,
  api,
  decodeJwt,
  hashToken,
  login,
  prisma,
  refreshLifetimeDays,
  registerUser,
  resetDatabase,
  uniqueEmail,
} from "./helpers.js";

beforeEach(resetDatabase);
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => prisma.$disconnect());

describe("GET /health", () => {
  it("responds ok", async () => {
    const res = await api().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("POST /api/auth/register", () => {
  it("creates the company and its owner, without logging in", async () => {
    const email = uniqueEmail();
    const res = await api()
      .post("/api/auth/register")
      .send({ fullName: "محمد أحمد", companyName: "شركة ميزان", email: email.toUpperCase(), password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, fullName: "محمد أحمد", role: "owner", company: { name: "شركة ميزان" } });
    expect(res.body).not.toHaveProperty("accessToken");
    expect(res.body).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");

    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects an email that is already registered", async () => {
    const { email } = await registerUser();
    const res = await api()
      .post("/api/auth/register")
      .send({ fullName: "Someone Else", companyName: "Other", email, password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
    expect(await prisma.company.count()).toBe(1);
  });

  it("returns field errors for invalid input", async () => {
    const res = await api().post("/api/auth/register").send({ fullName: "ab", email: "not-an-email", password: "123" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.body.error.details.fieldErrors).sort()).toEqual(
      ["companyName", "email", "fullName", "password"].sort(),
    );
  });
});

describe("POST /api/auth/login", () => {
  it("returns an access token, a refresh token and the user", async () => {
    const { email } = await registerUser();
    const res = await api().post("/api/auth/login").send({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    const { iat, exp } = decodeJwt(res.body.accessToken);
    expect(exp - iat).toBe(15 * 60);

    // Only the hash of the refresh token is stored.
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(res.body.refreshToken) } });
    expect(row.tokenHash).not.toBe(res.body.refreshToken);
  });

  it("gives the refresh token 1 day, or 30 days with remember", async () => {
    const { email } = await registerUser();
    expect(await refreshLifetimeDays((await login(email)).refreshToken)).toBe(1);
    expect(await refreshLifetimeDays((await login(email, PASSWORD, true)).refreshToken)).toBe(30);
  });

  it("accepts the email in any letter case", async () => {
    const { email } = await registerUser();
    const res = await api().post("/api/auth/login").send({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const { email } = await registerUser();
    const wrongPassword = await api().post("/api/auth/login").send({ email, password: "WrongPass1" });
    const unknownEmail = await api().post("/api/auth/login").send({ email: uniqueEmail(), password: "WrongPass1" });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    }
    expect(await prisma.refreshToken.count()).toBe(0);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the logged-in user", async () => {
    const { email } = await registerUser();
    const { accessToken } = await login(email);
    const res = await api().get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email, role: "owner" });
  });

  it("rejects a missing or malformed token", async () => {
    expect((await api().get("/api/auth/me")).status).toBe(401);
    expect((await api().get("/api/auth/me").set("Authorization", "Bearer not.a.jwt")).status).toBe(401);
  });

  it("rejects an access token after 15 minutes", async () => {
    const { email } = await registerUser();
    const { accessToken } = await login(email);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    const res = await api().get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/refresh", () => {
  it("swaps a refresh token for a new pair that works", async () => {
    const { email } = await registerUser();
    const session = await login(email, PASSWORD, true);

    const res = await api().post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(session.refreshToken);

    const me = await api().get("/api/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
    // "remember me" carries over to the rotated token.
    expect(await refreshLifetimeDays(res.body.refreshToken)).toBe(30);
  });

  it("ends the whole session when a used refresh token comes back", async () => {
    const { email } = await registerUser();
    const session = await login(email);
    const rotated = (await api().post("/api/auth/refresh").send({ refreshToken: session.refreshToken })).body;

    const reuse = await api().post("/api/auth/refresh").send({ refreshToken: session.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("REFRESH_TOKEN_REUSED");

    // The newest token in that session is now dead too.
    const latest = await api().post("/api/auth/refresh").send({ refreshToken: rotated.refreshToken });
    expect(latest.status).toBe(401);
  });

  it("lets only one of two simultaneous refreshes with the same token succeed", async () => {
    const { email } = await registerUser();
    const { refreshToken } = await login(email);

    const results = await Promise.all([
      api().post("/api/auth/refresh").send({ refreshToken }),
      api().post("/api/auth/refresh").send({ refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("rejects an unknown or expired refresh token", async () => {
    const unknown = await api().post("/api/auth/refresh").send({ refreshToken: "never-issued" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("INVALID_REFRESH_TOKEN");

    const { email } = await registerUser();
    const { refreshToken } = await login(email);
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await api().post("/api/auth/refresh").send({ refreshToken });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("requires a refresh token in the body", async () => {
    const res = await api().post("/api/auth/refresh").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/auth/logout", () => {
  it("ends the session so its refresh token stops working", async () => {
    const { email } = await registerUser();
    const { refreshToken } = await login(email);

    expect((await api().post("/api/auth/logout").send({ refreshToken })).status).toBe(204);
    expect((await api().post("/api/auth/refresh").send({ refreshToken })).status).toBe(401);
  });

  it("is harmless to repeat or call with an unknown token", async () => {
    const { email } = await registerUser();
    const { refreshToken } = await login(email);

    await api().post("/api/auth/logout").send({ refreshToken });
    expect((await api().post("/api/auth/logout").send({ refreshToken })).status).toBe(204);
    expect((await api().post("/api/auth/logout").send({ refreshToken: "never-issued" })).status).toBe(204);
  });
});

describe("POST /api/auth/change-password", () => {
  it("rejects a wrong current password", async () => {
    const { email } = await registerUser();
    const { accessToken } = await login(email);
    const res = await api()
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "nope", newPassword: "NewSecret456!" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
  });

  it("changes the password and ends every other session", async () => {
    const { email } = await registerUser();
    const phone = await login(email, PASSWORD, true);
    const laptop = await login(email);

    // Access tokens carry whole-second timestamps; move past the second they were issued in.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2000);

    const res = await api()
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${laptop.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: "NewSecret456!" });
    expect(res.status).toBe(200);

    // Old tokens from every device are dead.
    expect((await api().post("/api/auth/refresh").send({ refreshToken: phone.refreshToken })).status).toBe(401);
    expect((await api().get("/api/auth/me").set("Authorization", `Bearer ${laptop.accessToken}`)).status).toBe(401);

    // The pair returned by change-password works.
    expect((await api().get("/api/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`)).status).toBe(200);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: res.body.refreshToken })).status).toBe(200);

    // Only the new password logs in.
    expect((await api().post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email, password: "NewSecret456!" })).status).toBe(200);
  });
});

describe("errors", () => {
  it("returns 400 for malformed JSON", async () => {
    const res = await api().post("/api/auth/login").set("Content-Type", "application/json").send("{bad json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await api().get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("deleting a company removes its users and their sessions", async () => {
    const { email, user } = await registerUser();
    await login(email);
    await prisma.company.delete({ where: { id: user.company.id } });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.refreshToken.count()).toBe(0);
  });
});
