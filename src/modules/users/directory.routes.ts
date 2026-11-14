import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { authenticate } from "../../middleware/auth.js";

/**
 * GET /api/team-members: names of everyone in the company, for any logged-in
 * member (e.g. to pick who is responsible for a customer). Unlike /api/users
 * (owner only) it shows no emails.
 */
export function createDirectoryRouter() {
  const router = Router();

  router.get("/", authenticate, async (req, res) => {
    const members = await prisma.user.findMany({
      where: { companyId: req.user!.companyId },
      select: { id: true, fullName: true, role: true },
      orderBy: { fullName: "asc" },
    });
    res.json({ members });
  });

  return router;
}
