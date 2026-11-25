import { z } from "zod";
import { LOCALES } from "../email/templates.js";

export const email = z.string().trim().toLowerCase().pipe(z.email());
// Upper bound stops someone sending a huge string to make hashing slow.
export const newPassword = z.string().min(8).max(128);
/** The language of the emails this request sends (the page's language). */
export const locale = z.enum(LOCALES).default("ar");

export const registerSchema = z.object({
  fullName: z.string().trim().min(3).max(100),
  companyName: z.string().trim().min(1).max(150),
  email,
  password: newPassword,
  locale,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  remember: z.boolean().default(false),
});

export const changePasswordSchema = z.object({
  // Left out by an account made with Google that is setting its first password.
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword,
});

/**
 * "Continue with Google": the ID token Google gave the page. With companyName, an
 * unknown account is created (a new company, its owner); with invitationToken, the
 * invitation is accepted with this Google account instead of a password.
 */
export const googleSignInSchema = z.object({
  credential: z.string().min(20).max(5000),
  remember: z.boolean().default(false),
  companyName: registerSchema.shape.companyName.optional(),
  invitationToken: z.string().trim().min(1).max(200).optional(),
});

export type GoogleSignInInput = z.infer<typeof googleSignInSchema>;

export const forgotPasswordSchema = z.object({ email, locale });

export const accountTokenSchema = z.object({ token: z.string().min(1).max(200) });

/** The one-time code the browser handed the desktop app (see createDesktopSignInCode). */
export const desktopCodeSchema = z.object({ code: z.string().min(1).max(200) });

export const resetPasswordSchema = accountTokenSchema.extend({ password: newPassword });

export const localeSchema = z.object({ locale });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
