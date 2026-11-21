import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import type { InvitableRole } from "./users.schemas.js";
import { teamMemberSelect } from "./public-user.js";

export function listTeam(companyId: string) {
  return prisma.user.findMany({
    where: { companyId },
    select: teamMemberSelect,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Loads a user of this company that the owner is allowed to manage.
 * A user from another company gets a 404, exactly like one that does not exist.
 */
async function findManageableUser(companyId: string, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, companyId },
    select: { id: true, role: true, fullName: true },
  });
  if (!user) throw notFound("User");
  if (user.role === "owner") {
    throw new AppError(403, "CANNOT_MODIFY_OWNER", "The company owner cannot be changed or removed");
  }
  return user;
}

export async function changeRole(companyId: string, userId: string, role: InvitableRole) {
  const before = await findManageableUser(companyId, userId);
  // Takes effect on the user's next request: `authenticate` reads the role from the database.
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { role }, select: teamMemberSelect });
    if (before.role !== role) {
      await audit(tx, companyId, {
        action: "permissions",
        event: "roleChanged",
        item: { type: "user", id: userId, ref: before.fullName },
        values: { from: before.role, role },
      });
    }
    return user;
  });
}

export async function removeUser(companyId: string, userId: string) {
  const user = await findManageableUser(companyId, userId);
  // Their refresh tokens are deleted with them (cascade), and `authenticate`
  // rejects their access token on the next request because the user is gone.
  await prisma.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } });
    await audit(tx, companyId, {
      action: "permissions",
      event: "memberRemoved",
      item: { type: "user", ref: user.fullName },
      values: { role: user.role },
    });
  });
}
