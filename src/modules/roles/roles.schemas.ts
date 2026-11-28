import { z } from "zod";
import { PERMISSION_KEYS, type Permission } from "../../lib/permissions.js";

const permission = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

/** A role the owner makes: a name, and what it may do (at least one thing). */
export const roleSchema = z.object({
  name: z.string().trim().min(1).max(40),
  permissions: z.array(permission).min(1).max(PERMISSION_KEYS.length * 2),
});

export const updateRoleSchema = roleSchema
  .partial()
  .refine((v) => v.name !== undefined || v.permissions !== undefined, { message: "Nothing to change" });

export type RoleInput = z.infer<typeof roleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
