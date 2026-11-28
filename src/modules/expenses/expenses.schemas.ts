import { z } from "zod";
import { isoDate } from "../invoices/invoices.schemas.js";

export const expenseCategories = ["salaries", "rent", "purchases", "marketing", "utilities", "software"] as const;
export const expenseSources = ["bank", "cash", "card"] as const;

const amount = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals")
    .refine((v) => Number(v) > 0, "Must be more than 0"),
);

/** Like amount, but 0 is allowed (no VAT). */
const vatAmount = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals"),
);

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().max(max).nullable().optional(),
  );

export const createExpenseSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    category: z.enum(expenseCategories),
    amount,
    date: isoDate,
    status: z.enum(["paid", "due"]).default("paid"),
    /** Where the money came from (paid expenses). */
    paidFrom: z.enum(expenseSources).nullable().optional(),
    /** When it has to be paid (due expenses). */
    dueDate: isoDate.nullable().optional(),
    /** The supplier, from the list. */
    supplierId: z.uuid().nullable().optional(),
    /** Or a supplier's name: the one with that name, or a new one added to the list. */
    vendor: optionalText(120),
    /** The VAT included in amount (input VAT); left out or 0: none. */
    vat: vatAmount.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.vat !== undefined && Number(v.vat) >= Number(v.amount)) {
      ctx.addIssue({ code: "custom", path: ["vat"], message: "The VAT must be less than the amount" });
    }
    if (v.status === "due" && v.paidFrom) {
      ctx.addIssue({ code: "custom", path: ["paidFrom"], message: "A due expense isn't paid yet" });
    }
    if (v.status === "paid" && v.dueDate) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Only a due expense has a due date" });
    }
    if (v.dueDate && v.dueDate < v.date) {
      ctx.addIssue({ code: "custom", path: ["dueDate"], message: "The due date can't be before the expense date" });
    }
  });

export const payExpenseSchema = z.object({ paidFrom: z.enum(expenseSources) });

export const listExpensesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(["all", ...expenseCategories]).default("all"),
  status: z.enum(["all", "paid", "due"]).default("all"),
  period: z.enum(["all", "thisMonth", "lastMonth", "thisYear"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
