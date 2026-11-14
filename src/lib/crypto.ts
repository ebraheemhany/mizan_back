import { createHash, randomBytes } from "node:crypto";

/** A random, URL-safe secret (256 bits). Used for refresh tokens and invite links. */
export const generateToken = () => randomBytes(32).toString("base64url");

/** What we store instead of the token itself, so a database leak exposes no usable tokens. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
