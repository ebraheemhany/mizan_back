import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(1),
  REFRESH_TOKEN_REMEMBER_TTL_DAYS: z.coerce.number().positive().default(30),
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
