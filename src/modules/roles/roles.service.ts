// Roles the company's owner makes: a name and the permissions they pick. Members and
// invitations with role = custom point at one; its permissions apply on their next request.
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { PERMISSION_KEYS } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import type { RoleInput, UpdateRoleInput } from "./roles.schemas.js";

/** Enough for any company; a guard against runaway lists. */
const MAX_ROLES = 30;

/** Not accepted, not revoked, not expired. */
const pendingInvite = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

const nameTaken = () => new AppError(409, "ROLE_NAME_TAKEN", "A role with this name already exists");

/** In the fixed order of the permission list, each once. */
const tidy = (permissions: readonly string[]) => PERMISSION_KEYS.filter((key) => permissions.includes(key));

const roleSelect = () =>
  ({
    id: true,
    name: true,
    permissions: true,
    createdAt: true,
    _count: { select: { users: true, invitations: { where: pendingInvite() } } },
  }) satisfies Prisma.CompanyRoleSelect;

type RoleRow = Prisma.CompanyRoleGetPayload<{ select: ReturnType<typeof roleSelect> }>;

const roleDto = (r: RoleRow) => ({
  id: r.id,
  name: r.name,
  permissions: tidy(r.permissions),
  members: r._count.users,
  pendingInvitations: r._count.invitations,
  createdAt: r.createdAt,
});

export async function listRoles(companyId: string) {
  const rows = await prisma.companyRole.findMany({ where: { companyId }, select: roleSelect(), orderBy: { createdAt: "asc" } });
  return rows.map(roleDto);
}

/** A role of this company (another company's gets a 404, like one that doesn't exist). */
export async function findRole(db: Prisma.TransactionClient, companyId: string, id: string) {
  const role = await db.companyRole.findFirst({ where: { id, companyId }, select: { id: true, name: true, permissions: true } });
  if (!role) throw notFound("Role");
  return role;
}

function nameConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw nameTaken();
  throw err;
}

export async function createRole(companyId: string, input: RoleInput) {
  try {
    const role = await prisma.$transaction(async (tx) => {
      if ((await tx.companyRole.count({ where: { companyId } })) >= MAX_ROLES) {
        throw new AppError(409, "ROLE_LIMIT", "A company can have up to 30 roles", { limit: MAX_ROLES });
      }
      const created = await tx.companyRole.create({
        data: { companyId, name: input.name, permissions: tidy(input.permissions) },
        select: roleSelect(),
      });
      await audit(tx, companyId, {
        action: "permissions",
        event: "roleCreated",
        item: { type: "role", id: created.id, ref: created.name },
        values: { name: created.name, count: created.permissions.length },
      });
      return created;
    });
    return roleDto(role);
  } catch (err) {
    nameConflict(err);
  }
}

export async function updateRole(companyId: string, id: string, input: UpdateRoleInput) {
  try {
    const role = await prisma.$transaction(async (tx) => {
      const before = await findRole(tx, companyId, id);
      const updated = await tx.companyRole.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.permissions !== undefined ? { permissions: tidy(input.permissions) } : {}),
        },
        select: roleSelect(),
      });
      await audit(tx, companyId, {
        action: "permissions",
        event: "roleUpdated",
        item: { type: "role", id, ref: updated.name },
        values: { name: updated.name, from: before.name !== updated.name ? before.name : undefined, count: updated.permissions.length },
      });
      return updated;
    });
    return roleDto(role);
  } catch (err) {
    nameConflict(err);
  }
}

/** Only a role nobody has (and no pending invitation offers) can go. */
export async function deleteRole(companyId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const role = await findRole(tx, companyId, id);
    const [members, invitations] = await Promise.all([
      tx.user.count({ where: { customRoleId: id } }),
      tx.invitation.count({ where: { customRoleId: id, ...pendingInvite() } }),
    ]);
    if (members > 0 || invitations > 0) {
      throw new AppError(409, "ROLE_IN_USE", "Give its members another role first", { members, invitations });
    }
    // Old invitations (accepted, revoked or expired) only kept it for the record.
    await tx.invitation.updateMany({ where: { customRoleId: id }, data: { customRoleId: null } });
    await tx.companyRole.delete({ where: { id } });
    await audit(tx, companyId, {
      action: "permissions",
      event: "roleDeleted",
      item: { type: "role", ref: role.name },
      values: { name: role.name },
    });
  });
}
