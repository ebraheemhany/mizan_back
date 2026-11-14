import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { validateBody } from "../../middleware/validate.js";
import { acceptInvitationSchema, createInvitationSchema, invitationTokenSchema } from "./invitations.schemas.js";
import * as invitations from "./invitations.service.js";

export function createInvitationsRouter(limit: AuthRateLimiters) {
  const router = Router();

  // --- Public: used by the invited person, who has no account yet. ---
  // The token travels in the body, not the URL, so it never lands in request logs.

  router.post("/preview", limit.invitationToken, validateBody(invitationTokenSchema), async (req, res) => {
    res.json({ invitation: await invitations.previewInvitation(req.body.token) });
  });

  router.post("/accept", limit.invitationToken, validateBody(acceptInvitationSchema), async (req, res) => {
    res.status(201).json({ user: await invitations.acceptInvitation(req.body) });
  });

  // --- Owner only. ---
  const owner = [authenticate, requireRole("owner")];

  router.get("/", ...owner, async (req, res) => {
    res.json({ invitations: await invitations.listPendingInvitations(req.user!.companyId) });
  });

  router.post("/", ...owner, validateBody(createInvitationSchema), async (req, res) => {
    res.status(201).json(await invitations.createInvitation(req.user!, req.body));
  });

  router.delete("/:id", ...owner, async (req, res) => {
    await invitations.revokeInvitation(req.user!.companyId, parseId(req.params.id, "Invitation"));
    res.status(204).end();
  });

  return router;
}
