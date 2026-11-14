import type { Prisma } from "../../generated/prisma/client.js";

/** The fields of a user that are safe to send to the frontend. */
export const publicUserSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
  company: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

/** A member of the team, as the owner sees it in the team list. */
export const teamMemberSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;
