import { z } from "zod";
import { email, locale } from "../auth/auth.schemas.js";
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

export const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().max(max).nullable().optional(),
  );

/** One line of an invoice or a quote. */
export const lineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: decimal(3).refine((v) => Number(v) > 0, "Must be more than 0"),
  unitPrice: decimal(2),
  // null is accepted too (a line copied from a quote with no catalog item).
  productId: z.uuid().nullable().optional(),
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
  /**
   * The number of an accepted quote this invoice is made from. The quote is marked
   * converted in the same transaction (a quote converts once).
   */
  fromQuote: z
    .preprocess((v) => (typeof v === "string" && /^\d{1,9}$/.test(v.trim()) ? Number(v) : v), z.number().int().min(1))
    .optional(),
});

export const recordPaymentSchema = z.object({
  amount: decimal(2).refine((v) => Number(v) > 0, "Must be more than 0"),
  date: isoDate,
  method: z.enum(["cash", "bank", "card", "instapay", "vodafoneCash", "cheque"]),
  /** Where the money went in (bank account, cash box, e-wallet). */
  account: z.enum(["bank", "cashbox", "wallet"]).nullable().optional(),
  /** Transfer or cheque number. */
  reference: optionalText(100),
  note: optionalText(200),
});

export const reminderSchema = z.object({
  channel: z.enum(["email", "whatsapp"]),
  /** WhatsApp: the number it was sent to (recorded only; the app opens WhatsApp itself). */
  recipient: z.string().trim().max(200).optional(),
  /** Email: another address than the customer's. */
  to: email.optional(),
  message: z.string().trim().min(1).max(600),
  locale,
});

/** Emailing an issued invoice to the customer (a link to its page). */
export const emailInvoiceSchema = z.object({
  /** Another address than the customer's. */
  to: email.optional(),
  /** Replaces the standard greeting. */
  message: z.string().trim().max(2000).optional(),
  locale,
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
export type EmailInvoiceInput = z.infer<typeof emailInvoiceSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
