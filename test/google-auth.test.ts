import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type CryptoKey } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setGoogleKeysForTests } from "../src/lib/google-id.js";
import { testMail } from "../src/lib/mailer.js";
import { api, auth, invite, login, ownerSession, PASSWORD, prisma, registerUser, resetDatabase, uniqueEmail } from "./helpers.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
let googleKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  // Our own "Google": in tests the server trusts only this key's signatures.
  const pair = await generateKeyPair("RS256", { extractable: true });
  googleKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  setGoogleKeysForTests(createLocalJWKSet({ keys: [jwk] }));
  // Signs with the same key id, but isn't the trusted key.
  strangerKey = (await generateKeyPair("RS256")).privateKey;
});

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

let googleIds = 0;
type Claims = { sub?: string; email?: string; email_verified?: boolean; name?: string; aud?: string; iss?: string; expired?: boolean };

/** An ID token as Google would sign it (override any claim to make a bad one). */
async function googleToken(claims: Claims = {}, key: CryptoKey = googleKey) {
  const { aud = CLIENT_ID, iss = "https://accounts.google.com", expired = false, sub = `google-${Date.now()}-${googleIds++}`, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: uniqueEmail(), email_verified: true, name: "سارة علي", ...rest })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt(expired ? now - 7200 : now)
    .setExpirationTime(expired ? now - 3600 : now + 3600)
    .sign(key);
}

const google = (body: Record<string, unknown>) => api().post("/api/auth/google").send(body);

describe("POST /api/auth/google: new people", () => {
  it("asks for the company name first, with what Google said about the person", async () => {
    const email = uniqueEmail();
    const res = await google({ credential: await googleToken({ email, name: "سارة علي" }) });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "GOOGLE_NO_ACCOUNT", details: { email, fullName: "سارة علي" } });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("creates the company and its owner, confirmed, without a password, and signs in", async () => {
    const email = uniqueEmail();
    const res = await google({ credential: await googleToken({ email, sub: "g-owner-1" }), companyName: "شركة الأمل", remember: true });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ email, role: "owner", hasPassword: false, company: { name: "شركة الأمل" } });
    expect(res.body.user.emailVerifiedAt).toBeTruthy();
    expect(res.body.user).not.toHaveProperty("passwordHash");

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row).toMatchObject({ googleId: "g-owner-1", passwordHash: null });
    // No "confirm your email" email: Google has already verified it.
    expect(testMail.outbox.some((m) => m.to === email)).toBe(false);

    const me = await api().get("/api/auth/me").set(auth(res.body.accessToken));
    expect(me.body.user).toMatchObject({ email, hasPassword: false });
  });

  it("signs the same Google account in next time (no second company)", async () => {
    const email = uniqueEmail();
    await google({ credential: await googleToken({ email, sub: "g-again" }), companyName: "شركة الأمل" });
    const again = await google({ credential: await googleToken({ email, sub: "g-again" }) });
    expect(again.status).toBe(200);
    expect(again.body.user.email).toBe(email);
    expect(await prisma.company.count()).toBe(1);
  });

  it("can't sign in with a password it never had, until it sets one", async () => {
    const email = uniqueEmail();
    const created = await google({ credential: await googleToken({ email }), companyName: "شركة" });
    const withPassword = await api().post("/api/auth/login").send({ email, password: PASSWORD });
    expect(withPassword.status).toBe(401);
    expect(withPassword.body.error.code).toBe("INVALID_CREDENTIALS");

    // Its first password needs no current one.
    const set = await api()
      .post("/api/auth/change-password")
      .set(auth(created.body.accessToken))
      .send({ newPassword: "NewSecret123!" });
    expect(set.status).toBe(200);
    const session = await login(email, "NewSecret123!");
    expect((session.user as { hasPassword?: boolean }).hasPassword).toBe(true);
  });
});

describe("POST /api/auth/google: people who already have an account", () => {
  it("links Google to the account with the same email, confirms it, and signs in", async () => {
    const { email, user } = await registerUser();
    const res = await google({ credential: await googleToken({ email: email.toUpperCase(), sub: "g-link" }) });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, hasPassword: true });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.googleId).toBe("g-link");
    expect(row.emailVerifiedAt).toBeTruthy();
    // The password still works too.
    await login(email);

    const events = await prisma.auditEvent.findMany({ where: { companyId: user.company.id }, select: { event: true } });
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["googleLinked", "signedInWithGoogle"]));
  });

  it("refuses when the account is linked to a different Google account", async () => {
    const { email } = await registerUser();
    await google({ credential: await googleToken({ email, sub: "g-first" }) });
    const other = await google({ credential: await googleToken({ email, sub: "g-second" }) });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("GOOGLE_LINKED_ELSEWHERE");
  });

  it("ignores companyName for someone who already has an account", async () => {
    const { email } = await registerUser();
    const res = await google({ credential: await googleToken({ email }), companyName: "شركة تانية" });
    expect(res.status).toBe(200);
    expect(await prisma.company.count()).toBe(1);
  });
});

describe("POST /api/auth/google: invitations", () => {
  it("joins the company with the invited Google address, confirmed", async () => {
    const owner = await ownerSession();
    const { email, token } = await invite(owner.token, "sales");
    const res = await google({ credential: await googleToken({ email, name: "Sara Google" }), invitationToken: token });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, role: "sales", hasPassword: false, fullName: "Sara Google", company: { id: owner.companyId } });
    expect(res.body.user.emailVerifiedAt).toBeTruthy();
    const inv = await prisma.invitation.findFirstOrThrow({ where: { email } });
    expect(inv.acceptedAt).toBeTruthy();
  });

  it("refuses a Google account with another address (a forwarded link)", async () => {
    const owner = await ownerSession();
    const { email, token } = await invite(owner.token, "sales");
    const res = await google({ credential: await googleToken({ email: uniqueEmail() }), invitationToken: token });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "GOOGLE_EMAIL_MISMATCH", details: { email } });
    expect((await prisma.invitation.findFirstOrThrow({ where: { email } })).acceptedAt).toBeNull();
  });

  it("refuses a used or unknown invitation", async () => {
    const owner = await ownerSession();
    const { email, token } = await invite(owner.token, "viewer");
    await google({ credential: await googleToken({ email }), invitationToken: token });
    const twice = await google({ credential: await googleToken({ email }), invitationToken: token });
    expect(twice.status).toBe(400);
    const unknown = await google({ credential: await googleToken({ email }), invitationToken: "not-a-real-token" });
    expect(unknown.status).toBe(400);
  });
});

describe("POST /api/auth/google: tokens that aren't Google's or aren't for us", () => {
  it.each([
    ["signed by someone else", () => googleToken({}, strangerKey)],
    ["for another app", () => googleToken({ aud: "someone-else.apps.googleusercontent.com" })],
    ["from another issuer", () => googleToken({ iss: "https://evil.example.com" })],
    ["expired", () => googleToken({ expired: true })],
    ["not a token at all", async () => "x".repeat(40)],
  ])("rejects a token %s", async (_label, make) => {
    const res = await google({ credential: await make(), companyName: "شركة" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GOOGLE_TOKEN_INVALID");
    expect(await prisma.company.count()).toBe(0);
  });

  it("rejects an address Google hasn't verified", async () => {
    const res = await google({ credential: await googleToken({ email_verified: false }), companyName: "شركة" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("GOOGLE_EMAIL_UNVERIFIED");
  });

  it("wants a credential", async () => {
    const res = await google({ companyName: "شركة" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/change-password with a password", () => {
  it("still needs the current one", async () => {
    const owner = await ownerSession();
    const missing = await api().post("/api/auth/change-password").set(auth(owner.token)).send({ newPassword: "Another123!" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
  });
});
