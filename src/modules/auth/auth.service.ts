import { Prisma } from "../../generated/prisma/client.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import type { ChangePasswordInput, LoginInput, RegisterInput } from "./auth.schemas.js";
import { publicUserSelect, type PublicUser } from "../users/public-user.js";
import { issueTokens, revokeAllSessions, type TokenUser } from "./tokens.js";
import { audit } from "../audit/audit.service.js";
import { sendVerificationLater } from "./account-links.service.js";


const toTokenUser = (user: PublicUser): TokenUser => ({ id: user.id, companyId: user.company.id, role: user.role });

export async function register(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  let user: PublicUser;
  try {
    // Company and its owner are created together: if one fails, neither is saved.
    user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
          role: "owner",
          company: { create: { name: input.companyName } },
        },
        select: publicUserSelect,
      });
      await audit(
        tx,
        created.company.id,
        { action: "create", event: "companyCreated", item: { type: "company", id: created.company.id, ref: created.company.name } },
        { id: created.id, name: created.fullName },
      );
      return created;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }
    throw err;
  }

  // The "confirm your email" link goes out in the background.
  sendVerificationLater({ id: user.id, email: user.email, fullName: user.fullName, companyId: user.company.id }, input.locale);

  // No tokens here: after signing up, the user logs in to start a session.
  return { user };
}

export async function login(input: LoginInput) {
  const found = await prisma.user.findUnique({
    where: { email: input.email },
    select: { ...publicUserSelect, passwordHash: true },
  });

  const valid = found
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

  const { passwordHash: _passwordHash, ...user } = found;
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
  const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
  if (!user) throw unauthorized();
  return user;
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  const found = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!found || !(await verifyPassword(found.passwordHash, input.currentPassword))) {
    throw new AppError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
  }

  const passwordHash = await hashPassword(input.newPassword);
  // Truncate to whole seconds so an access token issued right after this is
  // still valid (JWT "iat" has one-second precision), while every older one is not.
  const passwordChangedAt = new Date(Math.floor(Date.now() / 1000) * 1000);

  // Update the password, end every existing session (all devices), and start a
  // new one for this device — all or nothing.
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { passwordHash, passwordChangedAt },
      select: publicUserSelect,
    });
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
