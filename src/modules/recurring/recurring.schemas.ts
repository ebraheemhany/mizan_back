import { z } from "zod";
import { isoDate, lineSchema, optionalText } from "../invoices/invoices.schemas.js";

export const recurringFrequencies = ["weekly", "monthly", "quarterly", "yearly"] as const;
export const recurringEndModes = ["never", "date", "count"] as const;

/**
 * A recurring template, for create and edit (edit sends every field again).
 * When it stops: never, after `endDate`, or after `occurrences` invoices.
 */
export const recurringSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    customerId: z.uuid(),
    frequency: z.enum(recurringFrequencies),
    /** The first invoice's date (today or later; checked in the service against Cairo's today). */
    startDate: isoDate,
    endMode: z.enum(recurringEndModes),
    endDate: isoDate.nullable().optional(),
    occurrences: z.number().int().min(1).max(120).nullable().optional(),
    /** Days until each invoice is due. */
    terms: z.number().int().min(0).max(365),
    /** true: each invoice is sent when made; false: it is saved as a draft to check first. */
    autoSend: z.boolean(),
    items: z.array(lineSchema).min(1).max(100),
    notes: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.endMode === "date") {
      if (!v.endDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Required when the template ends on a date" });
      else if (v.endDate <= v.startDate) ctx.addIssue({ code: "custom", path: ["endDate"], message: "Must be after the start date" });
    }
    if (v.endMode === "count" && !v.occurrences) {
      ctx.addIssue({ code: "custom", path: ["occurrences"], message: "Required when the template ends after a number of invoices" });
    }
  });

export const recurringListStatuses = ["all", "active", "paused", "ended"] as const;

export const listRecurringQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(recurringListStatuses).default("all"),
});

export type RecurringInput = z.infer<typeof recurringSchema>;
export type ListRecurringQuery = z.infer<typeof listRecurringQuerySchema>;
export type RecurringFrequency = (typeof recurringFrequencies)[number];
