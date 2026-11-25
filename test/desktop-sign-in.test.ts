import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, hashToken, login, prisma, refreshLifetimeDays, registerUser, resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const newCode = (accessToken: string) => api().post("/api/auth/desktop-code").set(auth(accessToken));
const redeem = (code: string) => api().post("/api/auth/desktop-code/redeem").send({ code });

async function signedIn() {
  const { email } = await registerUser();
  const session = await login(email);
  return { email, token: session.accessToken, userId: session.user.id };
}

describe("POST /api/auth/desktop-code", () => {
  it("needs a signed-in browser", async () => {
    const res = await api().post("/api/auth/desktop-code");
    expect(res.status).toBe(401);
  });

  it("gives a one-time code, stored only as a hash", async () => {
    const { token, userId } = await signedIn();
    const res = await newCode(token);
    expect(res.status).toBe(201);
    expect(typeof res.body.code).toBe("string");
    expect(res.body.code.length).toBeGreaterThanOrEqual(40);

    const row = await prisma.accountToken.findUniqueOrThrow({ where: { tokenHash: hashToken(res.body.code) } });
    expect(row).toMatchObject({ userId, purpose: "desktopSignIn", usedAt: null });
    // Minutes, not hours.
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

describe("POST /api/auth/desktop-code/redeem", () => {
  it("starts a session of the app's own, kept like \"remember me\"", async () => {
    const { email, token } = await signedIn();
    const { code } = (await newCode(token)).body;

    const res = await redeem(code);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email });
    expect(res.body.refreshToken).toBeTruthy();
    expect(new Date(res.body.refreshTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await refreshLifetimeDays(res.body.refreshToken)).toBe(30);

    const me = await api().get("/api/auth/me").set(auth(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email });

    // The browser's session keeps working alongside the app's.
    expect((await api().get("/api/auth/me").set(auth(token))).status).toBe(200);
  });

  it("works only once", async () => {
    const { token } = await signedIn();
    const { code } = (await newCode(token)).body;
    expect((await redeem(code)).status).toBe(200);

    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_DESKTOP_CODE");
  });

  it("refuses an expired code", async () => {
    const { token } = await signedIn();
    const { code } = (await newCode(token)).body;
    await prisma.accountToken.update({ where: { tokenHash: hashToken(code) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await redeem(code);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_DESKTOP_CODE");
  });

  it("refuses an unknown code", async () => {
    const res = await redeem("not-a-real-code");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_DESKTOP_CODE");
  });

  it("refuses an emailed link's token used as a code", async () => {
    const { userId, email } = await signedIn();
    const token = "a-password-reset-token-from-an-email";
    await prisma.accountToken.create({
      data: { purpose: "passwordReset", tokenHash: hashToken(token), email, userId, expiresAt: new Date(Date.now() + 60_000) },
    });

    const res = await redeem(token);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_DESKTOP_CODE");
  });

  it("goes in the company's activity log", async () => {
    const { token, email } = await signedIn();
    const { code } = (await newCode(token)).body;
    await redeem(code);

    const event = await prisma.auditEvent.findFirst({ where: { event: "signedInDesktop" } });
    expect(event).toMatchObject({ action: "login", itemRef: email });
  });
});
