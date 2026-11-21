import "dotenv/config";
import { z } from "zod";

/** A number that may be left empty in .env. */
const optionalId = z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().positive().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(1),
  REFRESH_TOKEN_REMEMBER_TTL_DAYS: z.coerce.number().positive().default(30),
  // Base URL of the frontend, used to build invite links.
  APP_URL: z.url().default("http://localhost:3000"),
  INVITATION_TTL_DAYS: z.coerce.number().positive().default(7),
  // Public base URL of this API (company logos in emails point here).
  API_URL: z.url().default("http://localhost:4000"),
  // Email, sent through Resend. Without a key nothing leaves the machine: in
  // development each email is written to MAIL_OUTBOX_DIR instead (open the .html).
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  // Must be on a domain verified in Resend (onboarding@resend.dev only reaches your own inbox).
  MAIL_FROM: z.string().default("Mizan <onboarding@resend.dev>"),
  MAIL_OUTBOX_DIR: z.string().default(".mail-outbox"),
  // Subscriptions through Paymob (Egypt). Without the keys, development uses a
  // local test checkout page instead; production refuses to take payments.
  PAYMOB_SECRET_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  PAYMOB_PUBLIC_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  PAYMOB_HMAC_SECRET: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
  // The card integration shown at checkout (it saves the card), and the MOTO one
  // that charges the saved card for renewals (Paymob enables it on request).
  PAYMOB_CARD_INTEGRATION_ID: optionalId,
  PAYMOB_MOTO_INTEGRATION_ID: optionalId,
  PAYMOB_API_URL: z.url().default("https://accept.paymob.com"),
  PAYMOB_CHECKOUT_URL: z.url().default("https://eg.checkout.paymob.com"),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().positive().default(60),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().positive().default(72),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((value) => value.split(",").map((origin) => origin.trim())),
  // How many proxies sit in front of the app ("false" = none, e.g. local dev).
  // Use the hop count (usually 1), never "true": that trusts any X-Forwarded-For
  // header, letting clients fake their IP and dodge rate limits.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((value) => (value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
