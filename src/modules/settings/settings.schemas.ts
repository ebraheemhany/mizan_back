import { z } from "zod";

/** Empty or whitespace-only text means "no value" (stored as null). */
const blankToNull = (value: unknown) =>
  typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToNull, schema.nullable());

// Same rules as the frontend settings form.
const companySection = z.strictObject({
  name: z.string().trim().min(1).max(120),
  // Egyptian tax registration number: 9 digits, dashes optional (412-558-903).
  taxNumber: optional(z.string().regex(/^\d{3}-?\d{3}-?\d{3}$/, "Invalid tax number")),
  commercialRegister: optional(z.string().regex(/^\d{3,15}$/, "Invalid commercial register")),
  phone: optional(z.string().regex(/^[0-9+\s-]{8,15}$/, "Invalid phone number")),
  address: optional(z.string().max(300)),
});

// The VAT rate in percent, up to 2 decimals ("14", "14.5"); kept as text for Decimal.
const vatRate = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v),
  z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals")
    .refine((v) => Number(v) > 0 && Number(v) <= 100, "Must be more than 0 and at most 100"),
);

const taxesSection = z.strictObject({
  vatEnabled: z.boolean(),
  // Optional: left out, the rate stays as it is.
  vatRate: vatRate.optional(),
  withholdingEnabled: z.boolean(),
  currency: z.enum(["EGP", "USD", "SAR", "AED"]),
  fiscalStartMonth: z.number().int().min(1).max(12),
});

const prefix = z.string().trim().regex(/^[A-Za-z0-9-]{1,10}$/, "Letters, digits and dashes only (max 10)");
const nextNumber = z.number().int().min(1).max(999_999_999);

const numberingSection = z.strictObject({
  invoicePrefix: prefix,
  invoiceNext: nextNumber,
  quotePrefix: prefix,
  quoteNext: nextNumber,
  paymentTermsDays: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45), z.literal(60)]),
});

const templateSection = z.strictObject({
  style: z.enum(["classic", "modern", "minimal"]),
  footer: optional(z.string().max(200)),
});

export const notificationsSection = z.strictObject({
  overdueInvoice: z.boolean(),
  newPayment: z.boolean(),
  taskReminder: z.boolean(),
  weeklyDigest: z.boolean(),
});

export const integrationsSection = z.strictObject({
  whatsapp: z.boolean(),
  paymentGateway: z.boolean(),
  eta: z.boolean(),
  calendar: z.boolean(),
});

/**
 * Any subset of sections; each section that is sent must be complete.
 * The settings page sends all of them; other screens can send just one.
 */
export const updateSettingsSchema = z
  .strictObject({
    company: companySection,
    taxes: taxesSection,
    numbering: numberingSection,
    template: templateSection,
    notifications: notificationsSection,
    integrations: integrationsSection,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Send at least one section");

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
