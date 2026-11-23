import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { config } from "../config.js";
import { AppError } from "./errors.js";
import { logger } from "./logger.js";

// "Sign in with Google": the page gets an ID token from Google (Google Identity
// Services) and posts it here. We trust it only if Google signed it, for our
// client id, recently, and Google has verified the email address in it.

export type GoogleProfile = {
  /** Google's stable id for the account. */
  sub: string;
  email: string;
  name: string;
};

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

let keys: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Tests sign their own tokens: they swap Google's keys for theirs. */
export function setGoogleKeysForTests(testKeys: JWTVerifyGetKey) {
  if (config.NODE_ENV !== "test") throw new Error("Only in tests");
  keys = testKeys;
}

export const googleSignInConfigured = () => Boolean(config.GOOGLE_CLIENT_ID);

const invalidToken = () =>
  new AppError(401, "GOOGLE_TOKEN_INVALID", "Google sign-in didn't work; try again");

export async function verifyGoogleIdToken(credential: string): Promise<GoogleProfile> {
  if (!config.GOOGLE_CLIENT_ID) {
    throw new AppError(503, "GOOGLE_SIGNIN_UNAVAILABLE", "Sign-in with Google isn't set up");
  }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(credential, keys, {
      issuer: GOOGLE_ISSUERS,
      audience: config.GOOGLE_CLIENT_ID,
      algorithms: ["RS256"],
      // Google's tokens last an hour; a little slack for clock drift.
      clockTolerance: 60,
    }));
  } catch (err) {
    logger.warn({ err }, "Rejected a Google ID token");
    throw invalidToken();
  }
  const { sub, email, email_verified: verified, name } = payload;
  if (typeof sub !== "string" || typeof email !== "string" || !sub || !email) throw invalidToken();
  // Without this anyone could claim an address they don't own on a Google account.
  if (verified !== true) {
    throw new AppError(403, "GOOGLE_EMAIL_UNVERIFIED", "This Google account's email isn't verified");
  }
  const cleanName = typeof name === "string" ? name.trim().slice(0, 100) : "";
  return { sub, email: email.trim().toLowerCase(), name: cleanName || email.split("@")[0]! };
}
