import { z } from "zod";
import { ETA_UNIT_CODES } from "../eta/eta.codes.js";

export const productTypes = ["service", "product"] as const;
export const productCategories = ["software", "support", "consulting", "devices", "network", "accessories"] as const;

/**
 * Money and percentages arrive as a string ("1850.50") or a number, and are kept
 * as a string so no precision is lost before Prisma stores them as Decimal.
 */
const decimal = (maxIntegerDigits: number) =>
  z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v),
    z.string().regex(new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,2})?$`), "Must be a non-negative number with up to 2 decimals"),
  );

const price = decimal(12);
const taxRate = decimal(3).refine((v) => Number(v) <= 100, "Must be between 0 and 100");
/** Stock quantities: kilos and metres too, so up to 3 decimals. */
const count = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z.string().regex(/^\d{1,10}(\.\d{1,3})?$/, "Must be a non-negative number with up to 3 decimals"),
);

const fields = {
  name: z.string().trim().min(1).max(120),
  type: z.enum(productTypes),
  code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .transform((v) => v.toUpperCase()),
  price,
  taxRate,
  category: z.enum(productCategories),
  // Products only; ignored (stored as null) for services.
  stock: count.optional(),
  lowStockAt: count.optional(),
  // E-invoicing (ETA): a GS1 barcode or the company's approved EGS code (EG-<tax no.>-<code>),
  // and the ETA unit (EA, KGM, M...). Empty clears them.
  etaCodeType: z.preprocess((v) => (v === "" ? null : v), z.enum(["GS1", "EGS"]).nullable().optional()),
  etaCode: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.string().max(100).regex(/^[A-Za-z0-9-]+$/, "Letters, digits and dashes").nullable().optional(),
  ),
  etaUnit: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.string().refine((v) => ETA_UNIT_CODES.has(v), "Not an ETA unit code").nullable().optional(),
  ),
};

export const createProductSchema = z.object(fields);
export const updateProductSchema = z.object(fields).partial();

export const listProductsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["all", ...productTypes]).default("all"),
  category: z.enum(["all", ...productCategories]).default("all"),
  // low: products at or under their alert level (out of stock included).
  stock: z.enum(["all", "low"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const nextCodeQuerySchema = z.object({ type: z.enum(productTypes) });

export const importProductsSchema = z.object({
  products: z.array(z.unknown()).min(1).max(1000),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
