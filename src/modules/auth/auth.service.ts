import { Prisma } from "../../generated/prisma/client.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import type { ChangePasswordInput, LoginInput, RegisterInput } from "./auth.schemas.js";
import { issueTokens, revokeAllSessions, type TokenUser } from "./tokens.js";

// The fields of a user that are safe to send to the frontend.
const publicUserSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
  company: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

const toTokenUser = (user: PublicUser): TokenUser => ({ id: user.id, companyId: user.company.id, role: user.role });

export async function register(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  let user: PublicUser;
  try {
    // Company and its owner are created together: if one fails, neither is saved.
    user = await prisma.user.create({
      data: {
        email: input.email,
        fullName: input.fullName,
        passwordHash,
        role: "owner",
        company: { create: { name: input.companyName } },
      },
      select: publicUserSelect,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }
    throw err;
  }

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

  // Same message for unknown email and wrong password.
  if (!found || !valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }

  const { passwordHash: _passwordHash, ...user } = found;
  return { ...(await issueTokens(toTokenUser(user), input.remember)), user };
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
    return issueTokens(toTokenUser(user), false, tx);
  });
}
