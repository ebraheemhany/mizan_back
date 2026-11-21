import { z } from "zod";
import { isoDate } from "../invoices/invoices.schemas.js";

export const dealStages = ["lead", "contacted", "proposal", "negotiation", "won"] as const;
/** A deal is won by moving it to "won", never by creating or editing it. */
export const openStages = ["lead", "contacted", "proposal", "negotiation"] as const;
export const lossReasons = ["price", "competitor", "postponed", "noResponse", "noNeed", "other"] as const;

const amount = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().replace(/,/g, "") : v),
  z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals")
    .refine((v) => Number(v) > 0, "Must be more than 0"),
);

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().max(max).nullable().optional(),
  );

const dealFields = {
  title: z.string().trim().min(1).max(80),
  customerId: z.uuid(),
  value: amount,
  // The responsible team member; null = nobody yet.
  ownerId: z.uuid().nullable().optional(),
  // When it is expected to close (it may already have passed: an overdue deal).
  closeDate: isoDate,
  followUpDate: isoDate.nullable().optional(),
  awaitingReply: z.boolean().optional(),
  notes: optionalText(500),
};

export const createDealSchema = z.object({ ...dealFields, stage: z.enum(openStages).default("lead") });

/** Editing a won deal leaves its stage alone (it is moved back from the board, if ever). */
export const updateDealSchema = z.object({ ...dealFields, stage: z.enum(openStages).optional() });

export const moveDealSchema = z.object({ stage: z.enum(dealStages) });

export const loseDealSchema = z.object({
  reason: z.enum(lossReasons),
  note: optionalText(300),
});

/** A follow-up done now; still waiting for the customer to answer, or not. */
export const touchDealSchema = z.object({ awaitingReply: z.boolean().default(false) });

export type CreateDealInput = z.infer<typeof createDealSchema>;
export type UpdateDealInput = z.infer<typeof updateDealSchema>;
export type DealStageValue = (typeof dealStages)[number];
export type LoseDealInput = z.infer<typeof loseDealSchema>;
