// One-time links emailed to a user: choose a new password, confirm the address.
// Only a hash of each link's token is stored; the token itself is only in the email.
import { config } from "../../config.js";
import type { AccountTokenPurpose, Prisma } from "../../generated/prisma/client.js";
import { generateToken, hashToken } from "../../lib/crypto.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { sendMail } from "../../lib/mailer.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { passwordResetEmail, verifyEmailEmail, type Locale } from "../email/templates.js";
import { revokeAllSessions } from "./tokens.js";

type Db = Prisma.TransactionClient;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const accountSelect = {
  id: true,
  email: true,
  fullName: true,
  companyId: true,
  emailVerifiedAt: true,
} satisfies Prisma.UserSelect;

export type Account = { id: string; email: string; fullName: string; companyId: string };

const invalidResetLink = () =>
  new AppError(400, "INVALID_RESET_TOKEN", "This link is invalid, already used, or has expired");
const invalidVerifyLink = () =>
  new AppError(400, "INVALID_VERIFICATION_TOKEN", "This link is invalid or has expired");

/** The page the link opens, in the language the email was written in. */
const linkUrl = (locale: Locale, page: string, token: string) =>
  new URL(`/${locale}/${page}/${token}`, config.APP_URL).toString();

/** A new link. A new password link replaces the earlier ones; confirmation links all keep working. */
async function createToken(db: Db, user: Account, purpose: AccountTokenPurpose, ttlMs: number) {
  // Housekeeping: links long past their date go.
  await db.accountToken.deleteMany({
    where: { userId: user.id, expiresAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
  });
  if (purpose === "passwordReset") {
    await db.accountToken.deleteMany({ where: { userId: user.id, purpose, usedAt: null } });
  }
  const token = generateToken();
  await db.accountToken.create({
    data: { purpose, tokenHash: hashToken(token), email: user.email, userId: user.id, expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

/** Uses a link up: once only, and only before it expires (two clicks at once: one wins). */
async function claimToken(db: Db, token: string, purpose: AccountTokenPurpose) {
  const tokenHash = hashToken(token);
  const { count } = await db.accountToken.updateMany({
    where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (count === 0) return null;
  return db.accountToken.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true, email: true } });
}

// ---------------------------------------------------------------------------
// Forgotten password
// ---------------------------------------------------------------------------

/**
 * Starts a password reset. It answers at once and the same way for any address:
 * the account lookup and the email happen afterwards, so neither the answer nor
 * how long it takes tells whether an account exists.
 */
export function requestPasswordReset(email: string, locale: Locale) {
  void sendPasswordReset(email, locale).catch((err) => logger.error({ err }, "Password reset email failed"));
}

async function sendPasswordReset(email: string, locale: Locale) {
  const user = await prisma.user.findUnique({ where: { email }, select: accountSelect });
  if (!user) return;
  const token = await prisma.$transaction(async (tx) => {
    const created = await createToken(tx, user, "passwordReset", config.PASSWORD_RESET_TTL_MINUTES * MINUTE_MS);
    await audit(
      tx,
      user.companyId,
      { action: "login", event: "passwordResetRequested", item: { type: "account", ref: user.email } },
      { id: user.id, name: user.fullName },
    );
    return created;
  });
  await sendMail(
    passwordResetEmail(
      locale,
      { email: user.email, name: user.fullName },
      linkUrl(locale, "reset-password", token),
      config.PASSWORD_RESET_TTL_MINUTES,
    ),
  );
}

/** Whether a reset link still works, and for which address (shown on the page). */
export async function previewPasswordReset(token: string) {
  const found = await prisma.accountToken.findFirst({
    where: { tokenHash: hashToken(token), purpose: "passwordReset", usedAt: null, expiresAt: { gt: new Date() } },
    select: { email: true },
  });
  if (!found) throw invalidResetLink();
  return { email: found.email };
}

/** Sets the new password and signs the account out everywhere; the user then logs in. */
export async function resetPassword(token: string, password: string) {
  // Cheap check first, so a bad link doesn't cost a (deliberately slow) password hash.
  await previewPasswordReset(token);
  const passwordHash = await hashPassword(password);
  // Whole seconds: an access token issued right after this is still valid (JWT "iat"
  // has one-second precision), while every older one is not.
  const passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);

  await prisma.$transaction(async (tx) => {
    const claimed = await claimToken(tx, token, "passwordReset");
    if (!claimed) throw invalidResetLink();
    const user = await tx.user.findUniqueOrThrow({ where: { id: claimed.userId }, select: accountSelect });
    // Sent to an address the account no longer has.
    if (user.email !== claimed.email) throw invalidResetLink();

    await tx.user.update({
      where: { id: user.id },
      // Opening the link proved the inbox is theirs.
      data: { passwordHash, passwordChangedAt, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    });
    await tx.accountToken.deleteMany({ where: { userId: user.id, purpose: "passwordReset", usedAt: null } });
    await revokeAllSessions(user.id, tx);
    await audit(
      tx,
      user.companyId,
      { action: "login", event: "passwordReset", item: { type: "account", ref: user.email } },
      { id: user.id, name: user.fullName },
    );
  });
}

// ---------------------------------------------------------------------------
// Confirming the email address
// ---------------------------------------------------------------------------

async function sendVerification(user: Account, locale: Locale) {
  const token = await createToken(prisma, user, "emailVerification", config.EMAIL_VERIFICATION_TTL_HOURS * HOUR_MS);
  await sendMail(
    verifyEmailEmail(
      locale,
      { email: user.email, name: user.fullName },
      linkUrl(locale, "verify-email", token),
      config.EMAIL_VERIFICATION_TTL_HOURS,
    ),
  );
}

/** After signing up or joining a team: the email goes out without holding up the answer. */
export function sendVerificationLater(user: Account, locale: Locale) {
  void sendVerification(user, locale).catch((err) => logger.error({ err }, "Verification email failed"));
}

/** "Send the link again", from the banner. Throws EMAIL_FAILED if it couldn't go. */
export async function resendVerification(userId: string, locale: Locale) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: accountSelect });
  if (!user) throw unauthorized();
  if (user.emailVerifiedAt) throw new AppError(409, "ALREADY_VERIFIED", "This email is already confirmed");
  await sendVerification(user, locale);
}

export async function verifyEmail(token: string) {
  return prisma.$transaction(async (tx) => {
    const claimed = await claimToken(tx, token, "emailVerification");
    if (!claimed) {
      // Opened twice (or a mail scanner opened it first): fine while that address is confirmed.
      const used = await tx.accountToken.findFirst({
        where: { tokenHash: hashToken(token), purpose: "emailVerification", usedAt: { not: null } },
        select: { email: true, user: { select: { email: true, emailVerifiedAt: true } } },
      });
      if (used?.user.emailVerifiedAt && used.user.email === used.email) return { email: used.email };
      throw invalidVerifyLink();
    }

    const user = await tx.user.findUniqueOrThrow({ where: { id: claimed.userId }, select: accountSelect });
    if (user.email !== claimed.email) throw invalidVerifyLink();
    if (!user.emailVerifiedAt) {
      await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      await audit(
        tx,
        user.companyId,
        { action: "login", event: "emailVerified", item: { type: "account", ref: user.email } },
        { id: user.id, name: user.fullName },
      );
    }
    return { email: user.email };
  });
}
