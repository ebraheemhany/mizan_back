import { z } from "zod";
import { businessToday } from "../../lib/dates.js";

export const PERIOD_KEYWORDS = ["thisQuarter", "thisYear"] as const;
const MONTH = /^[12]\d{3}-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" (not after the current month), "thisQuarter" or "thisYear". */
const periodKey = z.string().superRefine((value, ctx) => {
  if ((PERIOD_KEYWORDS as readonly string[]).includes(value)) return;
  if (!MONTH.test(value)) {
    ctx.addIssue({ code: "custom", message: "Use a month like 2026-10, thisQuarter or thisYear" });
  } else if (value > businessToday().slice(0, 7)) {
    ctx.addIssue({ code: "custom", message: "The month can't be in the future" });
  }
});

/** Left out = the current month (Cairo). */
export const periodQuerySchema = z.object({ period: periodKey.optional() });

export const statementQuerySchema = periodQuerySchema.extend({
  // Required; a malformed id is a 404 (parseId), like everywhere else.
  customerId: z.string().min(1),
});

export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export type StatementQuery = z.infer<typeof statementQuerySchema>;
