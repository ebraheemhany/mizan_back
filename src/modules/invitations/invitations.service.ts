import { config } from "../../config.js";
import { Prisma } from "../../generated/prisma/client.js";
import { generateToken, hashToken } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { hashPassword } from "../../lib/password.js";
import { prisma } from "../../lib/prisma.js";
import { publicUserSelect } from "../users/public-user.js";
import type { AcceptInvitationInput, CreateInvitationInput } from "./invitations.schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const invitationSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.InvitationSelect;

/** Not accepted, not revoked, not expired. */
const pending = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

const invalidInvitation = () =>
  new AppError(400, "INVALID_INVITATION", "This invitation link is invalid, already used, or has expired");

const emailTaken = () => new AppError(409, "EMAIL_TAKEN", "An account with this email already exists");

const inviteUrl = (token: string) => new URL(`/invite/${token}`, config.APP_URL).toString();

type Inviter = { id: string; companyId: string };

export async function createInvitation(inviter: Inviter, input: CreateInvitationInput) {
  // Emails are unique across the whole system, not per company.
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw emailTaken();

  const token = generateToken();

  const invitation = await prisma.$transaction(async (tx) => {
    // Inviting the same email again replaces the earlier invite: its link stops working.
    await tx.invitation.updateMany({
      where: { companyId: inviter.companyId, email: input.email, ...pending() },
      data: { revokedAt: new Date() },
    });

    return tx.invitation.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + config.INVITATION_TTL_DAYS * DAY_MS),
        companyId: inviter.companyId,
        invitedById: inviter.id,
      },
      select: invitationSelect,
    });
  });

  // The token is only ever returned here, inside the link. It cannot be read back later.
  return { invitation, inviteUrl: inviteUrl(token) };
}

export function listPendingInvitations(companyId: string) {
  return prisma.invitation.findMany({
    where: { companyId, ...pending() },
    select: invitationSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvitation(companyId: string, id: string) {
  const { count } = await prisma.invitation.updateMany({
    where: { id, companyId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw notFound("Invitation");
}

/** What the invited person sees before accepting: who invited them, to which company, as what. */
export async function previewInvitation(token: string) {
  const invitation = await prisma.invitation.findFirst({
    where: { tokenHash: hashToken(token), ...pending() },
    select: { email: true, name: true, role: true, expiresAt: true, company: { select: { name: true } } },
  });
  if (!invitation) throw invalidInvitation();
  return invitation;
}

export async function acceptInvitation(input: AcceptInvitationInput) {
  const tokenHash = hashToken(input.token);

  // Cheap check first, so a bad link does not cost a (deliberately slow) password hash.
  const found = await prisma.invitation.findFirst({ where: { tokenHash, ...pending() }, select: { id: true } });
  if (!found) throw invalidInvitation();

  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      // Claim the invite. The conditions make this atomic: if the same link is
      // accepted twice at once, only one request gets count === 1.
      const { count } = await tx.invitation.updateMany({
        where: { id: found.id, ...pending() },
        data: { acceptedAt: new Date() },
      });
      if (count === 0) throw invalidInvitation();

      const invitation = await tx.invitation.findUniqueOrThrow({ where: { id: found.id } });

      return tx.user.create({
        data: {
          email: invitation.email,
          fullName: input.fullName ?? invitation.name,
          passwordHash,
          role: invitation.role,
          companyId: invitation.companyId,
        },
        select: publicUserSelect,
      });
    });
  } catch (err) {
    // Someone registered with this email after the invite was sent. The transaction
    // rolled back, so the invite stays pending.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw emailTaken();
    throw err;
  }
}
