import "dotenv/config";
import { z } from "zod";

/** A number that may be left empty in .env. */
const optionalId = z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().positive().optional());

/** Text that may be left empty in .env. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const GMAIL_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GMAIL_SENDER"] as const;

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
  // Email goes through Resend (needs a domain of our own) or, without one, a Gmail
  // account (the GMAIL_* values, from `npm run gmail:token`); Resend wins if both are
  // set. With neither, nothing leaves the machine: in development each email is
  // written to MAIL_OUTBOX_DIR instead (open the .html).
  RESEND_API_KEY: optionalText,
  // Resend only: must be on a domain verified in Resend (onboarding@resend.dev only
  // reaches your own inbox). With Gmail just its name is used ("Mizan").
  MAIL_FROM: z.string().default("Mizan <onboarding@resend.dev>"),
  GMAIL_CLIENT_ID: optionalText,
  GMAIL_CLIENT_SECRET: optionalText,
  GMAIL_REFRESH_TOKEN: optionalText,
  GMAIL_SENDER: z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.email().optional()),
  // Encrypts secrets companies give us (their Paymob keys). 32 random bytes, base64:
  // `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  // Required in production to save them; changing it makes saved ones unreadable.
  ENCRYPTION_KEY: optionalText.refine(
    (value) => value === undefined || Buffer.from(value, "base64").length === 32,
    "ENCRYPTION_KEY must be 32 bytes, base64",
  ),
  // "Sign in with Google": the Web application OAuth client's id (not secret; the same
  // value as the frontend's NEXT_PUBLIC_GOOGLE_CLIENT_ID). Empty: the option is off.
  GOOGLE_CLIENT_ID: optionalText,
  MAIL_OUTBOX_DIR: z.string().default(".mail-outbox"),
  // The in-app assistant (Claude). Without a key the assistant is off (the app hides it).
  ANTHROPIC_API_KEY: optionalText,
  // Which Claude model answers, and how hard it thinks (low = cheaper and faster).
  ASSISTANT_MODEL: z.string().trim().min(1).default("claude-opus-5-5"),
  ASSISTANT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
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
  // Mizan's own staff: these accounts also open the platform admin pages (every
  // company, its plan and how much it uses Mizan). Comma-separated emails; empty = nobody.
  PLATFORM_ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
}).superRefine((env, ctx) => {
  // Half a Gmail setup would silently send nothing: all four or none.
  const set = GMAIL_KEYS.filter((key) => env[key] !== undefined);
  if (set.length > 0 && set.length < GMAIL_KEYS.length) {
    for (const key of GMAIL_KEYS.filter((k) => env[k] === undefined)) {
      ctx.addIssue({ code: "custom", path: [key], message: "Set all four GMAIL_* values, or none" });
    }
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
