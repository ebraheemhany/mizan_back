import { z } from "zod";
import { email, newPassword } from "../auth/auth.schemas.js";

// Nobody can be invited as owner: each company has exactly one, the person who registered it.
export const invitableRoles = ["accountant", "sales", "viewer"] as const;

export const createInvitationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email,
  role: z.enum(invitableRoles),
});

export const invitationTokenSchema = z.object({
  token: z.string().min(1).max(200),
});

export const acceptInvitationSchema = invitationTokenSchema.extend({
  password: newPassword,
  // Optional: the invited person can correct the name the owner typed.
  fullName: z.string().trim().min(3).max(100).optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
