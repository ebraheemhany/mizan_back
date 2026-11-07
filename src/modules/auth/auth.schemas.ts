import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email());
// Upper bound stops someone sending a huge string to make hashing slow.
const newPassword = z.string().min(8).max(128);

export const registerSchema = z.object({
  fullName: z.string().trim().min(3).max(100),
  companyName: z.string().trim().min(1).max(150),
  email,
  password: newPassword,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  remember: z.boolean().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
