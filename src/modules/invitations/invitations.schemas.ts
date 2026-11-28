import { z } from "zod";
import { email, locale, newPassword } from "../auth/auth.schemas.js";

// Nobody can be invited as owner: each company has exactly one, the person who registered it.
// "custom" is one of the owner's own roles (customRoleId says which).
export const invitableRoles = ["accountant", "sales", "viewer", "custom"] as const;

/** The role someone gets: a built-in one, or a custom one with its id. */
export const roleChoice = {
  role: z.enum(invitableRoles),
  customRoleId: z.uuid().optional(),
};

/** customRoleId comes with "custom", and only then. */
export const roleChoiceComplete = {
  check: (v: { role: string; customRoleId?: string | undefined }) => (v.role === "custom") === (v.customRoleId !== undefined),
  params: { path: ["customRoleId"], message: "Choose the custom role (only for role \"custom\")" },
};

export const createInvitationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email,
    ...roleChoice,
    // The language of the invitation email.
    locale,
  })
  .refine(roleChoiceComplete.check, roleChoiceComplete.params);

export const invitationTokenSchema = z.object({
  token: z.string().min(1).max(200),
});

export const acceptInvitationSchema = invitationTokenSchema.extend({
  password: newPassword,
  // Optional: the invited person can correct the name the owner typed.
  fullName: z.string().trim().min(3).max(100).optional(),
  locale,
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
