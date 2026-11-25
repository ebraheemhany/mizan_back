import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "./errors.js";

// Secrets a company gives us (its Paymob secret key and HMAC secret) are stored
// encrypted: AES-256-GCM with ENCRYPTION_KEY, so a copy of the database alone
// doesn't hand them out. Stored as "v1.<iv>.<tag>.<ciphertext>" (base64url).

/** The key: ENCRYPTION_KEY (32 bytes, base64), or, outside production, one derived from JWT_SECRET. */
function key() {
  if (config.ENCRYPTION_KEY) return Buffer.from(config.ENCRYPTION_KEY, "base64");
  if (config.NODE_ENV === "production") {
    throw new AppError(503, "ENCRYPTION_NOT_SET", "Saving payment keys isn't set up on the server");
  }
  return createHash("sha256").update(`mizan-dev-secret-box:${config.JWT_SECRET}`).digest();
}

export function seal(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

export function open(sealed: string) {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Not a sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
