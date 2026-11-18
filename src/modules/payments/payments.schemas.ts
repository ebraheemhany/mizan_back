import { z } from "zod";
import { recordPaymentSchema } from "../invoices/invoices.schemas.js";

export const paymentMethods = ["cash", "bank", "card", "instapay", "vodafoneCash", "cheque"] as const;

/** Recording a payment from the payments page: the invoice is chosen in the form. */
export const createPaymentSchema = recordPaymentSchema.extend({ invoiceId: z.uuid() });

export const listPaymentsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  method: z.enum(["all", ...paymentMethods]).default("all"),
  period: z.enum(["all", "thisMonth", "lastMonth", "thisYear"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
