import { Prisma } from "../../generated/prisma/client.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import { verifyGoogleIdToken, type GoogleProfile } from "../../lib/google-id.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import type { ChangePasswordInput, GoogleSignInInput, LoginInput, RegisterInput } from "./auth.schemas.js";
import { sessionUserSelect, toSessionUser, type PublicUser, type SessionUser } from "../users/public-user.js";
import { issueTokens, revokeAllSessions, type TokenUser } from "./tokens.js";
import { audit } from "../audit/audit.service.js";
import { acceptInvitationWithGoogle } from "../invitations/invitations.service.js";
import { sendVerificationLater } from "./account-links.service.js";

const toTokenUser = (user: PublicUser): TokenUser => ({ id: user.id, companyId: user.company.id, role: user.role });

const emailTaken = () => new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");

type NewOwner = {
  email: string;
  fullName: string;
  companyName: string;
  passwordHash: string | null;
  googleId?: string;
  emailVerifiedAt?: Date;
};

/** A new company and its owner, together: if one fails, neither is saved. */
async function createCompany(owner: NewOwner): Promise<SessionUser> {
  const { companyName, ...user } = owner;
  try {
    return await prisma.$transaction(async (tx) => {
      const created = toSessionUser(
        await tx.user.create({
          data: { ...user, role: "owner", company: { create: { name: companyName } } },
          select: sessionUserSelect,
        }),
      );
      await audit(
        tx,
        created.company.id,
        { action: "create", event: "companyCreated", item: { type: "company", id: created.company.id, ref: created.company.name } },
        { id: created.id, name: created.fullName },
      );
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw emailTaken();
    throw err;
  }
}

export async function register(input: RegisterInput) {
  const user = await createCompany({
    email: input.email,
    fullName: input.fullName,
    companyName: input.companyName,
    passwordHash: await hashPassword(input.password),
  });

  // The "confirm your email" link goes out in the background.
  sendVerificationLater({ id: user.id, email: user.email, fullName: user.fullName, companyId: user.company.id }, input.locale);

  // No tokens here: after signing up, the user logs in to start a session.
  return { user };
}

/**
 * "Continue with Google", for every case: an account already linked to this Google
 * account signs in; an account with the same (Google-verified) address gets linked
 * and signs in; an invitation is accepted; and an unknown person gets a new company
 * once they have given its name. Without a name the answer is GOOGLE_NO_ACCOUNT, with
 * the name and address Google gave, so the page can ask for it.
 */
export async function continueWithGoogle(input: GoogleSignInInput) {
  const google = await verifyGoogleIdToken(input.credential);

  let user: SessionUser | null;
  let created = false;
  if (input.invitationToken) {
    user = await acceptInvitationWithGoogle(input.invitationToken, google);
    created = true;
  } else {
    user = await findOrLinkGoogleAccount(google);
    if (!user) {
      if (!input.companyName) {
        throw new AppError(404, "GOOGLE_NO_ACCOUNT", "No account uses this Google account yet", {
          email: google.email,
          fullName: google.name,
        });
      }
      user = await createCompany({
        email: google.email,
        fullName: google.name,
        companyName: input.companyName,
        passwordHash: null,
        googleId: google.sub,
        emailVerifiedAt: new Date(),
      });
      created = true;
    }
  }

  const tokens = await issueTokens(toTokenUser(user), input.remember);
  await audit(
    prisma,
    user.company.id,
    { action: "login", event: "signedInWithGoogle", item: { type: "account", ref: user.email } },
    { id: user.id, name: user.fullName },
  );
  return { ...tokens, user, created };
}

/** The account for this Google account: already linked, or linked now by its email address. */
async function findOrLinkGoogleAccount(google: GoogleProfile): Promise<SessionUser | null> {
  const linked = await prisma.user.findUnique({ where: { googleId: google.sub }, select: sessionUserSelect });
  if (linked) return toSessionUser(linked);

  const byEmail = await prisma.user.findUnique({
    where: { email: google.email },
    select: { ...sessionUserSelect, googleId: true },
  });
  if (!byEmail) return null;
  // The address belongs to an account that signs in with a different Google account.
  if (byEmail.googleId) {
    throw new AppError(409, "GOOGLE_LINKED_ELSEWHERE", "This account is linked to another Google account");
  }

  return prisma.$transaction(async (tx) => {
    // Google has verified the address, so it counts as confirmed here too.
    const updated = await tx.user.update({
      where: { id: byEmail.id },
      data: { googleId: google.sub, emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() },
      select: sessionUserSelect,
    });
    const user = toSessionUser(updated);
    await audit(
      tx,
      user.company.id,
      { action: "login", event: "googleLinked", item: { type: "account", ref: user.email } },
      { id: user.id, name: user.fullName },
    );
    return user;
  });
}

export async function login(input: LoginInput) {
  const found = await prisma.user.findUnique({
    where: { email: input.email },
    select: sessionUserSelect,
  });

  // An account made with Google has no password until it sets one: like a wrong one.
  const valid = found?.passwordHash
    ? await verifyPassword(found.passwordHash, input.password)
    : await verifyAgainstDummy(input.password);

  // A wrong password for a real account goes in that company's log (someone may be
  // guessing). An unknown email belongs to no company, so there is nowhere to log it.
  if (found && !valid) {
    await audit(
      prisma,
      found.company.id,
      { action: "login", event: "signInFailed", item: { type: "account", ref: found.email } },
      { id: found.id, name: found.fullName },
    );
  }
  // Same message for unknown email and wrong password.
  if (!found || !valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }

  const user = toSessionUser(found);
  const tokens = await issueTokens(toTokenUser(user), input.remember);
  await audit(
    prisma,
    user.company.id,
    { action: "login", event: "signedIn", item: { type: "account", ref: user.email } },
    { id: user.id, name: user.fullName },
  );
  return { ...tokens, user };
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: sessionUserSelect });
  if (!user) throw unauthorized();
  return toSessionUser(user);
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  const found = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!found) throw unauthorized();
  // An account made with Google sets its first password without one to confirm.
  if (
    found.passwordHash !== null &&
    !(input.currentPassword && (await verifyPassword(found.passwordHash, input.currentPassword)))
  ) {
    throw new AppError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
  }

  const passwordHash = await hashPassword(input.newPassword);
  // Truncate to whole seconds so an access token issued right after this is
  // still valid (JWT "iat" has one-second precision), while every older one is not.
  const passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);

  // Update the password, end every existing session (all devices), and start a
  // new one for this device — all or nothing.
  return prisma.$transaction(async (tx) => {
    const user = toSessionUser(
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt },
        select: sessionUserSelect,
      }),
    );
    await revokeAllSessions(userId, tx);
    await audit(
      tx,
      user.company.id,
      { action: "login", event: "passwordChanged", item: { type: "account", ref: user.email } },
      { id: user.id, name: user.fullName },
    );
    return issueTokens(toTokenUser(user), false, tx);
  });
}
