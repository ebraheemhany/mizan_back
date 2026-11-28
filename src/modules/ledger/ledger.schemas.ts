import { z } from "zod";
import { isoDate } from "../invoices/invoices.schemas.js";

export const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Must be a month like 2026-10");

export const accountSchema = z.object({
  code: z.string().trim().regex(/^\d{2,10}$/, "2 to 10 digits"),
  name: z.string().trim().min(1).max(80),
  type: z.enum(accountTypes),
});

export const updateAccountSchema = accountSchema.omit({ type: true });

/** An amount on one side of a line: up to 2 decimals; empty means 0. */
const side = z.preprocess(
  (v) => {
    if (v === null || v === undefined) return "0";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v.trim().replace(/,/g, "") || "0";
    return v;
  },
  z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals"),
);

export const entrySchema = z.object({
  date: isoDate,
  memo: z.string().trim().min(1).max(200),
  // Posted counts in the balances; a draft waits for review.
  status: z.enum(["draft", "posted"]).default("posted"),
  lines: z
    .array(
      z
        .object({ accountId: z.uuid(), debit: side, credit: side })
        // Each line is a debit or a credit, never both or neither.
        .refine((l) => (Number(l.debit) > 0) !== (Number(l.credit) > 0), "One of debit or credit, more than 0"),
    )
    .min(2)
    .max(50),
});

export const listEntriesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  // payment includes cheques clearing; expense includes paying a due expense.
  source: z.enum(["all", "invoice", "payment", "expense", "payroll", "stock", "manual"]).default("all"),
  status: z.enum(["all", "posted", "draft"]).default("all"),
  month: month.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const trialBalanceQuerySchema = z.object({
  month: z.union([z.literal("all"), month]).default("all"),
});

export const monthBodySchema = z.object({ month });

export type AccountInput = z.infer<typeof accountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type EntryInput = z.infer<typeof entrySchema>;
export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;
