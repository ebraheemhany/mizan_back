import { z } from "zod";
import { roleChoice, roleChoiceComplete, invitableRoles } from "../invitations/invitations.schemas.js";

/** A built-in role, or "custom" with the owner's role (customRoleId). */
export const changeRoleSchema = z.object(roleChoice).refine(roleChoiceComplete.check, roleChoiceComplete.params);

export type InvitableRole = (typeof invitableRoles)[number];
export type RoleChoice = z.infer<typeof changeRoleSchema>;
