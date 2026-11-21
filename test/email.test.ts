import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testMail, type Mail } from "../src/lib/mailer.js";
import { api, auth, hashToken, login, ownerSession, PASSWORD, prisma, registerUser, resetDatabase, uniqueEmail } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

/** The email of this kind to this address (some are sent in the background: wait for it). */
async function mailTo(to: string, tag: string) {
  let found: Mail | undefined;
  await vi.waitFor(() => {
    found = testMail.outbox.find((m) => m.to === to && m.tag === tag);
    if (!found) throw new Error(`no ${tag} email to ${to}`);
  });
  return found!;
}

/** The token at the end of the link in the email. */
const tokenIn = (mail: Mail, page: string) => {
  const match = mail.text.match(new RegExp(`http://localhost:3000/(ar|en)/${page}/([\\w-]{43})`));
  if (!match) throw new Error(`no ${page} link in: ${mail.text}`);
  return { locale: match[1], token: match[2]! };
};

describe("confirming the email address", () => {
  it("sign-up sends the link; opening it confirms the address (twice is fine), and it's logged", async () => {
    const { email, user } = await registerUser();
    expect(user.emailVerifiedAt).toBeNull();
    const mail = await mailTo(email, "verify-email");
    expect(mail.subject).toBe("أكد إيميلك على ميزان");
    expect(mail.html).toContain('dir="rtl"');
    const { locale, token } = tokenIn(mail, "verify-email");
    expect(locale).toBe("ar");
    // Only its hash is stored.
    expect(await prisma.accountToken.count({ where: { tokenHash: hashToken(token), purpose: "emailVerification" } })).toBe(1);

    const verified = await api().post("/api/auth/verify-email").send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ email });
    const session = await login(email);
    expect(session.user).toMatchObject({ email });
    const me = await api().get("/api/auth/me").set(auth(session.accessToken));
    expect(me.body.user.emailVerifiedAt).not.toBeNull();

    // A second click (or a mail scanner that opened it first) still says yes.
    expect((await api().post("/api/auth/verify-email").send({ token })).status).toBe(200);
    expect((await api().post("/api/auth/verify-email").send({ token: "x".repeat(43) })).body.error.code).toBe(
      "INVALID_VERIFICATION_TOKEN",
    );

    const log = await api().get("/api/audit").set(auth(session.accessToken));
    expect(log.body.items.filter((i: { event: string }) => i.event === "emailVerified")).toHaveLength(1);
  });

  it("English sign-up gets the English email; the link can be sent again until confirmed", async () => {
    const email = uniqueEmail();
    await api().post("/api/auth/register").send({ fullName: "Sara Ali", companyName: "Nile Co", email, password: PASSWORD, locale: "en" });
    const first = await mailTo(email, "verify-email");
    expect(first.subject).toBe("Confirm your email on Mizan");
    expect(first.html).toContain('dir="ltr"');
    expect(tokenIn(first, "verify-email").locale).toBe("en");

    const { accessToken } = await login(email);
    testMail.outbox.length = 0;
    expect((await api().post("/api/auth/verify-email/resend").set(auth(accessToken)).send({ locale: "ar" })).status).toBe(204);
    const again = await mailTo(email, "verify-email");
    // Both links work (an older email opened later is fine).
    await api().post("/api/auth/verify-email").send({ token: tokenIn(first, "verify-email").token }).expect(200);
    expect((await api().post("/api/auth/verify-email").send({ token: tokenIn(again, "verify-email").token })).status).toBe(200);

    const done = await api().post("/api/auth/verify-email/resend").set(auth(accessToken)).send({});
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("ALREADY_VERIFIED");
    expect((await api().post("/api/auth/verify-email/resend").send({})).status).toBe(401);
  });

  it("an expired link doesn't confirm; a failed send says so", async () => {
    const { email } = await registerUser();
    const { token } = tokenIn(await mailTo(email, "verify-email"), "verify-email");
    await prisma.accountToken.updateMany({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post("/api/auth/verify-email").send({ token })).status).toBe(400);

    const { accessToken } = await login(email);
    testMail.fail = true;
    const res = await api().post("/api/auth/verify-email/resend").set(auth(accessToken)).send({});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("EMAIL_FAILED");
  });
});

describe("forgotten password", () => {
  it("the same answer for any address; only a real account gets an email", async () => {
    const { email } = await registerUser();
    const unknown = uniqueEmail();
    expect((await api().post("/api/auth/forgot-password").send({ email: unknown })).status).toBe(204);
    expect((await api().post("/api/auth/forgot-password").send({ email: email.toUpperCase() })).status).toBe(204);

    const mail = await mailTo(email, "password-reset");
    expect(mail.subject).toBe("استعادة كلمة السر على ميزان");
    expect(mail.text).toContain("60 دقيقة");
    expect(testMail.outbox.some((m) => m.to === unknown)).toBe(false);
    expect((await api().post("/api/auth/forgot-password").send({ email: "not-an-email" })).status).toBe(400);
  });

  it("the link shows the address, sets a new password once, ends every session and confirms the email", async () => {
    const { email } = await registerUser();
    const before = await login(email);
    await api().post("/api/auth/forgot-password").send({ email, locale: "en" });
    const mail = await mailTo(email, "password-reset");
    expect(mail.subject).toBe("Reset your Mizan password");
    const { token, locale } = tokenIn(mail, "reset-password");
    expect(locale).toBe("en");

    expect((await api().get(`/api/auth/reset-password/${token}`)).body).toEqual({ email });
    expect((await api().post("/api/auth/reset-password").send({ token, password: "short" })).status).toBe(400);
    // Access tokens count in whole seconds: one from the same second as the reset would still pass.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await api().post("/api/auth/reset-password").send({ token, password: "NewSecret456!" })).status).toBe(204);

    // Old password and old sessions are gone; the new password works.
    expect((await api().post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(401);
    expect((await api().post("/api/auth/refresh").send({ refreshToken: before.refreshToken })).status).toBe(401);
    expect((await api().get("/api/auth/me").set(auth(before.accessToken))).status).toBe(401);
    const after = await login(email, "NewSecret456!");
    expect((await api().get("/api/auth/me").set(auth(after.accessToken))).body.user.emailVerifiedAt).not.toBeNull();

    // Used once only.
    const again = await api().post("/api/auth/reset-password").send({ token, password: "Another789!" });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("INVALID_RESET_TOKEN");
    expect((await api().get(`/api/auth/reset-password/${token}`)).status).toBe(400);

    const log = await api().get("/api/audit?action=login").set(auth(after.accessToken));
    const events = log.body.items.map((i: { event: string }) => i.event);
    expect(events).toEqual(expect.arrayContaining(["passwordResetRequested", "passwordReset"]));
  });

  it("a newer request replaces the older link; an expired link doesn't work", async () => {
    const { email } = await registerUser();
    await api().post("/api/auth/forgot-password").send({ email });
    const first = tokenIn(await mailTo(email, "password-reset"), "reset-password").token;
    testMail.outbox.length = 0;
    await api().post("/api/auth/forgot-password").send({ email });
    const second = tokenIn(await mailTo(email, "password-reset"), "reset-password").token;

    expect((await api().get(`/api/auth/reset-password/${first}`)).status).toBe(400);
    expect((await api().get(`/api/auth/reset-password/${second}`)).status).toBe(200);

    await prisma.accountToken.updateMany({ where: { tokenHash: hashToken(second) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().post("/api/auth/reset-password").send({ token: second, password: "NewSecret456!" })).status).toBe(400);
    expect((await api().post("/api/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
  });
});

describe("invitations by email", () => {
  it("the invitee gets the link; if the email can't go, the invite still stands", async () => {
    const owner = await ownerSession();
    const email = uniqueEmail();
    const res = await api().post("/api/invitations").set(auth(owner.token)).send({ name: "سارة علي", email, role: "sales" });
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    const mail = await mailTo(email, "invitation");
    expect(mail.subject).toBe("دعوة للانضمام لـ شركة ميزان على ميزان");
    expect(mail.text).toContain("بدور «مبيعات»");
    expect(mail.text).toContain(res.body.inviteUrl);

    testMail.fail = true;
    const other = await api().post("/api/invitations").set(auth(owner.token)).send({ name: "Omar", email: uniqueEmail(), role: "viewer", locale: "en" });
    expect(other.status).toBe(201);
    expect(other.body.emailSent).toBe(false);
    expect(other.body.inviteUrl).toMatch(/^http:\/\/localhost:3000\/en\/invite\//);
  });

  it("joining sends the confirmation link; names are escaped in the HTML", async () => {
    const owner = await ownerSession();
    await prisma.company.update({ where: { id: owner.companyId }, data: { name: '<img src=x onerror="alert(1)">' } });
    const email = uniqueEmail();
    const res = await api().post("/api/invitations").set(auth(owner.token)).send({ name: "<b>Sara</b>", email, role: "sales" });
    const mail = await mailTo(email, "invitation");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("<b>Sara</b>");
    expect(mail.html).toContain("&lt;b&gt;Sara&lt;/b&gt;");

    const token = new URL(res.body.inviteUrl).pathname.split("/").pop()!;
    await api().post("/api/invitations/accept").send({ token, password: PASSWORD }).expect(201);
    await mailTo(email, "verify-email");
  });
});
