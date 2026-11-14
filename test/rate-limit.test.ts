import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { PASSWORD, login, prisma, registerUser, resetDatabase, uniqueEmail } from "./helpers.js";

// A new app per test means fresh, empty rate-limit counters with the real limits.
let api: () => ReturnType<typeof request>;
beforeEach(async () => {
  await resetDatabase();
  const app = createApp();
  api = () => request(app);
});
afterAll(() => prisma.$disconnect());

const wrongLogin = (email: string) => api().post("/api/auth/login").send({ email, password: "WrongPass1" });

function expectBlocked(res: request.Response) {
  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe("TOO_MANY_REQUESTS");
  expect(res.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
}

describe("login rate limit", () => {
  it("blocks an account after 10 wrong passwords, even with the right one", async () => {
    const { email } = await registerUser();

    for (let i = 0; i < 10; i++) {
      expect((await wrongLogin(email)).status).toBe(401);
    }
    expectBlocked(await wrongLogin(email));
    expectBlocked(await api().post("/api/auth/login").send({ email, password: PASSWORD }));

    // Other accounts from the same IP are not affected.
    const other = await registerUser();
    expect((await api().post("/api/auth/login").send({ email: other.email, password: PASSWORD })).status).toBe(200);
  });

  it("counts the email case-insensitively", async () => {
    const { email } = await registerUser();
    for (let i = 0; i < 10; i++) {
      await wrongLogin(i % 2 ? email.toUpperCase() : email);
    }
    expectBlocked(await wrongLogin(email));
  });

  it("never blocks successful logins", async () => {
    const { email } = await registerUser();
    for (let i = 0; i < 15; i++) {
      expect((await api().post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
    }
  });

  it("blocks an IP after 50 wrong passwords across different emails", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await wrongLogin(uniqueEmail())).status).toBe(401);
    }
    expectBlocked(await wrongLogin(uniqueEmail()));
  }, 30_000); // 51 argon2 checks, which are deliberately slow (~100ms each)

  it("sends rate limit headers", async () => {
    const { email } = await registerUser();
    const res = await wrongLogin(email);
    expect(res.headers["ratelimit-policy"]).toBeDefined();
    expect(res.headers["ratelimit"]).toBeDefined();
  });
});

describe("register rate limit", () => {
  it("allows 5 sign-ups per hour from one IP", async () => {
    const signUp = () =>
      api()
        .post("/api/auth/register")
        .send({ fullName: "Test User", companyName: "Co", email: uniqueEmail(), password: PASSWORD });

    for (let i = 0; i < 5; i++) {
      expect((await signUp()).status).toBe(201);
    }
    expectBlocked(await signUp());
    expect(await prisma.user.count()).toBe(5);
  });
});

describe("change-password rate limit", () => {
  it("blocks a user after 5 wrong current passwords, without affecting others", async () => {
    const victim = await registerUser();
    const other = await registerUser();
    const { accessToken } = await login(victim.email);
    const otherSession = await login(other.email);

    const change = (token: string, currentPassword: string) =>
      api()
        .post("/api/auth/change-password")
        .set("Authorization", `Bearer ${token}`)
        .send({ currentPassword, newPassword: "NewSecret456!" });

    for (let i = 0; i < 5; i++) {
      expect((await change(accessToken, "guess-" + i)).status).toBe(400);
    }
    expectBlocked(await change(accessToken, PASSWORD));

    // The password did not change.
    expect((await api().post("/api/auth/login").send({ email: victim.email, password: PASSWORD })).status).toBe(200);
    // Another user (same IP) can still change theirs.
    expect((await change(otherSession.accessToken, PASSWORD)).status).toBe(200);
  });
});
