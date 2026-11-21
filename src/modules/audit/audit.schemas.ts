import { z } from "zod";

export const auditActions = [
  "create",
  "update",
  "delete",
  "send",
  "cancel",
  "payment",
  "permissions",
  "login",
  "settings",
  "books",
] as const;

const filters = {
  q: z.string().trim().max(100).optional(),
  // A user's id, or "system" for what nobody signed in did.
  userId: z.union([z.literal("system"), z.uuid()]).optional(),
  action: z.enum(["all", ...auditActions]).default("all"),
  period: z.enum(["d7", "d30", "d90", "all"]).default("d30"),
};

export const listAuditQuerySchema = z.object({
  ...filters,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const exportAuditQuerySchema = z.object(filters);

export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
