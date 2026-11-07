import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { Prisma, Role } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { signAccessToken } from "../../lib/jwt.js";
import { prisma } from "../../lib/prisma.js";

type Db = Prisma.TransactionClient;

export type TokenUser = { id: string; companyId: string; role: Role };

export type TokenPair = { accessToken: string; refreshToken: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const lifetimeMs = (persistent: boolean) =>
  (persistent ? config.REFRESH_TOKEN_REMEMBER_TTL_DAYS : config.REFRESH_TOKEN_TTL_DAYS) * DAY_MS;

const invalidRefreshToken = () => new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");

async function createRefreshToken(db: Db, userId: string, persistent: boolean, familyId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.refreshToken.create({
    data: {
      tokenHash: hashToken(token),
      familyId,
      userId,
      persistent,
      expiresAt: new Date(Date.now() + lifetimeMs(persistent)),
    },
  });
  return token;
}

const signFor = (user: TokenUser) => signAccessToken({ sub: user.id, companyId: user.companyId, role: user.role });

/** Starts a new session (login, register, password change). */
export async function issueTokens(user: TokenUser, persistent: boolean, db: Db = prisma): Promise<TokenPair> {
  // Housekeeping: drop this user's expired tokens so the table does not grow forever.
  await db.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });

  const refreshToken = await createRefreshToken(db, user.id, persistent, randomUUID());
  return { accessToken: await signFor(user), refreshToken };
}

/** Exchanges a refresh token for a new pair. The used refresh token stops working. */
export async function rotateRefreshToken(token: string): Promise<TokenPair> {
  const found = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, companyId: true, role: true } } },
  });
  if (!found || found.expiresAt <= new Date()) throw invalidRefreshToken();

  // Mark it used. The "revokedAt: null" condition makes this atomic: if two
  // requests race with the same token, only one of them gets count === 1.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: found.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (count === 0) {
    // An already-used token came back: it was probably stolen. End the whole session.
    await revokeFamily(found.familyId);
    throw new AppError(401, "REFRESH_TOKEN_REUSED", "Session was ended for security reasons, please log in again");
  }

  const refreshToken = await createRefreshToken(prisma, found.userId, found.persistent, found.familyId);
  return { accessToken: await signFor(found.user), refreshToken };
}

/** Logout: ends the session the given refresh token belongs to. Unknown tokens are ignored. */
export async function revokeSession(token: string) {
  const found = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { familyId: true },
  });
  if (found) await revokeFamily(found.familyId);
}

/** Ends every session of a user (used on password change). */
export function revokeAllSessions(userId: string, db: Db = prisma) {
  return db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

function revokeFamily(familyId: string) {
  return prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}
