import { z } from "zod";
import { email, locale } from "../auth/auth.schemas.js";
import { isoDate, lineSchema, optionalText } from "../invoices/invoices.schemas.js";

/** The fields of a quote, shared by create and edit (edit replaces the whole draft). */
const quoteFields = {
  customerId: z.uuid(),
  issueDate: isoDate,
  /** Last day the offer stands; after it a sent quote shows as expired. */
  validUntil: isoDate,
  items: z.array(lineSchema).min(1).max(100),
  notes: optionalText(500),
};

const validUntilAfterIssue = {
  check: (v: { issueDate: string; validUntil: string }) => v.validUntil > v.issueDate,
  params: { path: ["validUntil"], message: "Must be after the issue date" },
};

export const createQuoteSchema = z
  .object({
    ...quoteFields,
    /** true = send it now ("save and send"); false = keep it as a draft. */
    send: z.boolean().default(false),
  })
  .refine(validUntilAfterIssue.check, validUntilAfterIssue.params);

/** Editing a draft: every field is sent again (missing notes clear them). */
export const updateQuoteSchema = z.object(quoteFields).refine(validUntilAfterIssue.check, validUntilAfterIssue.params);

export const quoteListStatuses = ["all", "draft", "sent", "accepted", "rejected", "expired"] as const;

export const listQuotesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(quoteListStatuses).default("all"),
  /** By issue date, Cairo calendar. */
  period: z.enum(["all", "month", "lastMonth", "year"]).default("all"),
  /** "false": only quotes not turned into an invoice yet (e.g. accepted ones still to invoice). */
  converted: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Emailing a sent quote to the customer (a link to its page, where they accept or decline). */
export const emailQuoteSchema = z.object({
  to: email.optional(),
  /** Replaces the standard greeting. */
  message: z.string().trim().max(2000).optional(),
  locale,
});

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type EmailQuoteInput = z.infer<typeof emailQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>;
export type QuoteListStatus = (typeof quoteListStatuses)[number];
