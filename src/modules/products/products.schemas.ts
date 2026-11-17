import { z } from "zod";

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
const count = z.coerce.number().int().min(0).max(1_000_000_000);

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
};

export const createProductSchema = z.object(fields);
export const updateProductSchema = z.object(fields).partial();

export const listProductsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["all", ...productTypes]).default("all"),
  category: z.enum(["all", ...productCategories]).default("all"),
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
