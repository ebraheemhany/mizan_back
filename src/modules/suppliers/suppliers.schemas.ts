import { z } from "zod";

// Same rules as the customers' fields.
const PHONE = /^\+?[\d\s-]{8,15}$/;

/** Empty or whitespace-only text means "no value" (stored as null). */
const blankToNull = (value: unknown) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value;

/** Missing = leave unchanged (on update); "" or null = clear it. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

const supplierFields = {
  name: z.string().trim().min(1).max(120),
  phone: optional(z.string().regex(PHONE, "Invalid phone number")),
  email: optional(z.email().max(254)),
  // Egyptian tax registration number: 9 digits, dashes optional (412-558-903).
  taxNumber: optional(z.string().regex(/^\d{3}-?\d{3}-?\d{3}$/, "Invalid tax number")),
  notes: optional(z.string().max(500)),
};

export const createSupplierSchema = z.object(supplierFields);
export const updateSupplierSchema = z.object(supplierFields).partial();
export const listSuppliersQuerySchema = z.object({ q: z.string().trim().max(100).optional() });

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;
