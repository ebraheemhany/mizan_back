import { z } from "zod";
import { invitableRoles } from "../invitations/invitations.schemas.js";

export const changeRoleSchema = z.object({
  role: z.enum(invitableRoles),
});

export type InvitableRole = (typeof invitableRoles)[number];
