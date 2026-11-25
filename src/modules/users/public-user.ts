import type { Prisma } from "../../generated/prisma/client.js";

/** The fields of a user that are safe to send to the frontend. */
export const publicUserSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
  // null until the user opens the link emailed to them.
  emailVerifiedAt: true,
  // The currency: the app shows every amount in it.
  company: { select: { id: true, name: true, currency: true } },
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

/** What the logged-in user gets about themselves: also whether they have a password. */
export const sessionUserSelect = { ...publicUserSelect, passwordHash: true } satisfies Prisma.UserSelect;

export type SessionUser = PublicUser & {
  /** false for an account made with Google that never set one (no "current password" to ask). */
  hasPassword: boolean;
};

/** Drops the hash itself: only whether there is one leaves the server. */
export function toSessionUser(row: Prisma.UserGetPayload<{ select: typeof sessionUserSelect }>): SessionUser {
  const { passwordHash, ...user } = row;
  return { ...user, hasPassword: passwordHash !== null };
}

/** A member of the team, as the owner sees it in the team list. */
export const teamMemberSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;
