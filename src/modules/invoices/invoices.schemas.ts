import { z } from "zod";
import { isIsoDate } from "../../lib/dates.js";

/** A calendar date, "yyyy-mm-dd". */
export const isoDate = z.string().refine(isIsoDate, "Must be a date like 2026-10-13");

/** A non-negative decimal sent as a string or number; kept as a string so nothing is rounded early. */
const decimal = (maxDecimals: number) =>
  z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
    z
      .string()
      .regex(new RegExp(`^\\d{1,12}(\\.\\d{1,${maxDecimals}})?$`), `Must be a number with up to ${maxDecimals} decimals`),
  );

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().max(max).nullable().optional(),
  );

const lineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: decimal(3).refine((v) => Number(v) > 0, "Must be more than 0"),
  unitPrice: decimal(2),
  productId: z.uuid().optional(),
});

export const createInvoiceSchema = z.object({
  customerId: z.uuid(),
  issueDate: isoDate,
  /** Days until the due date. */
  terms: z.number().int().min(0).max(365),
  items: z.array(lineSchema).min(1).max(200),
  notes: optionalText(500),
  /** true = issue it now ("save and send"); false = keep it as a draft. */
  send: z.boolean().default(false),
});

export const recordPaymentSchema = z.object({
  amount: decimal(2).refine((v) => Number(v) > 0, "Must be more than 0"),
  date: isoDate,
  method: z.enum(["cash", "bank", "card"]),
  note: optionalText(200),
});

export const reminderSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
  recipient: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(600),
});

export const bulkCancelSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) });

export const invoiceListStatuses = ["all", "draft", "sent", "partial", "paid", "overdue", "cancelled"] as const;

export const listInvoicesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(invoiceListStatuses).default("all"),
  customerId: z.uuid().optional(),
  period: z.enum(["all", "thisMonth", "lastMonth", "thisYear"]).default("all"),
  sort: z.enum(["recent", "oldest", "amount", "due"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type ReminderInput = z.infer<typeof reminderSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
