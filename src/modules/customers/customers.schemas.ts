import { z } from "zod";

// Same rule as the frontend form: digits, spaces, dashes, optional leading +.
const PHONE = /^\+?[\d\s-]{8,15}$/;

/** Empty or whitespace-only text means "no value" (stored as null). */
const blankToNull = (value: unknown) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value;

/**
 * An optional text field: missing = leave unchanged (on update), "" or null = clear it.
 * The preprocess runs first, so the inner schema always sees trimmed text or null.
 */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

const customerFields = {
  name: z.string().trim().min(1).max(80),
  contactName: optional(z.string().max(80)),
  phone: optional(z.string().regex(PHONE, "Invalid phone number")),
  email: optional(z.email().max(254)),
  city: optional(z.string().max(60)),
  taxNumber: optional(z.string().max(30)),
  notes: optional(z.string().max(500)),
  assignedToId: optional(z.uuid()),
};

export const createCustomerSchema = z.object(customerFields);
export const updateCustomerSchema = z.object(customerFields).partial();

export const customerStatuses = ["active", "inactive", "overdue"] as const;
export type CustomerStatus = (typeof customerStatuses)[number];

export const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["all", ...customerStatuses]).default("all"),
  /** A team member's id, or "none" for customers nobody is responsible for. */
  assignedTo: z.union([z.uuid(), z.literal("none")]).optional(),
  balance: z.enum(["all", "due", "zero"]).default("all"),
  sort: z.enum(["recent", "oldest", "balance", "name"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const ids = z.array(z.uuid()).min(1).max(500);

export const bulkDeleteSchema = z.object({ ids });

export const bulkAssignSchema = z.object({
  ids,
  /** null removes the assignment. */
  assignedToId: z.uuid().nullable(),
});

export const importCustomersSchema = z.object({
  // Each row is checked with createCustomerSchema in the service, so errors can
  // point at the exact row.
  customers: z.array(z.unknown()).min(1).max(1000),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;
