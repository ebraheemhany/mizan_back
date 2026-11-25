import { z } from "zod";
import { LOCALES } from "../email/templates.js";
import { isoDate, optionalText, recordPaymentSchema } from "../invoices/invoices.schemas.js";

// Collecting invoice payments from customers on the invoice link: the details shown
// for transfers, the company's own Paymob account, and the receipts customers send.

/** How customers can transfer to the company. Every field is optional; empty ones aren't shown. */
export const transferDetailsSchema = z.strictObject({
  bankName: optionalText(80),
  accountName: optionalText(120),
  // An account number or an IBAN.
  accountNumber: optionalText(40).refine((v) => !v || /^[A-Za-z0-9 -]{4,40}$/.test(v), "Letters, digits, spaces and dashes only"),
  // name@instapay, or the phone number behind it.
  instapayAddress: optionalText(80),
  walletNumber: optionalText(20).refine((v) => !v || /^[0-9+\s-]{8,20}$/.test(v), "Invalid phone number"),
  instructions: optionalText(300),
});

/** The company's own Paymob account (Dashboard → Settings → Account info, and Developers → Payment integrations). */
export const paymobAccountSchema = z
  .strictObject({
    secretKey: z.string().trim().regex(/^egy_sk_(test|live)_\w{10,200}$/, "Paste the secret key (egy_sk_...)"),
    publicKey: z.string().trim().regex(/^egy_pk_(test|live)_\w{10,200}$/, "Paste the public key (egy_pk_...)"),
    hmacSecret: z.string().trim().min(16).max(200),
    integrationId: z.coerce.number().int().positive().max(2_000_000_000),
  })
  .refine((v) => v.secretKey.startsWith("egy_sk_live_") === v.publicKey.startsWith("egy_pk_live_"), {
    path: ["publicKey"],
    message: "Both keys must be test keys, or both live keys",
  });

/** What a customer says about a transfer they made (in the query string; the receipt is the body). */
export const claimQuerySchema = z.object({
  amount: recordPaymentSchema.shape.amount,
  date: isoDate,
  method: z.enum(["bank", "instapay", "vodafoneCash"]),
  reference: optionalText(100),
  payerName: optionalText(100),
  note: optionalText(300),
});

export const acceptClaimSchema = z.object({
  /** Where the money went in; by default the bank for transfers and InstaPay, the wallet for wallets. */
  account: z.enum(["bank", "cashbox", "wallet"]).optional(),
});

export const rejectClaimSchema = z.object({ reason: z.string().trim().min(2).max(300) });

export const checkoutSchema = z.object({ locale: z.enum(LOCALES).default("ar") });

export const listClaimsQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "rejected", "all"]).default("pending"),
});

export type TransferDetailsInput = z.infer<typeof transferDetailsSchema>;
export type PaymobAccountInput = z.infer<typeof paymobAccountSchema>;
export type ClaimInput = z.infer<typeof claimQuerySchema>;
