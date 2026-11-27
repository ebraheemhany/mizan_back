import { z } from "zod";

export const ADMIN_PAGE_SIZE = 25;

export const listCompaniesQuerySchema = z.object({
  /** Company name, or the owner's name or email. */
  q: z.string().trim().max(100).optional(),
  /** The plan in force (free = no subscription, or an ended one). */
  plan: z.enum(["all", "free", "pro", "business"]).default("all"),
  sort: z.enum(["newest", "oldest", "active", "usage", "name"]).default("newest"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

/**
 * A plan paid outside Paymob (cash, a transfer), recorded by Mizan's staff: the same
 * plan is extended from the end of its paid period; another plan (or none) starts today.
 */
export const activateSubscriptionSchema = z.object({
  plan: z.enum(["pro", "business"]),
  months: z.number().int().min(1).max(24),
  /** What the company paid (EGP), kept as a string so nothing is rounded early. */
  amount: z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
    z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Must be an amount with up to 2 decimals"),
  ),
  /** How it was paid, for the record (seen only here). */
  note: z.string().trim().max(200).optional(),
});

export type ActivateSubscriptionInput = z.infer<typeof activateSubscriptionSchema>;
