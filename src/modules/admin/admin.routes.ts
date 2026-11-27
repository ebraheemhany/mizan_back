import { Router, type RequestHandler } from "express";
import { authenticate } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { AppError } from "../../lib/errors.js";
import { isPlatformAdmin } from "../../lib/platform-admin.js";
import { prisma } from "../../lib/prisma.js";
import { activateSubscriptionSchema, listCompaniesQuerySchema } from "./admin.schemas.js";
import { activateSubscription, getCompany, getOverview, listCompanies } from "./admin.service.js";

/**
 * Mizan's own staff only (PLATFORM_ADMIN_EMAILS). Anyone else gets a plain 404, as if
 * these pages didn't exist.
 */
const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { email: true } });
  if (!user || !isPlatformAdmin(user.email)) throw new AppError(404, "NOT_FOUND", "Not found");
  next();
};

export function createAdminRouter() {
  const router = Router();
  router.use(authenticate, requirePlatformAdmin);

  router.get("/overview", async (_req, res) => {
    res.json(await getOverview());
  });

  router.get("/companies", async (req, res) => {
    res.json(await listCompanies(parseQuery(listCompaniesQuerySchema, req.query)));
  });

  router.get("/companies/:id", async (req, res) => {
    res.json(await getCompany(String(req.params.id)));
  });

  // A plan paid outside Paymob (cash, a transfer): activated or extended by hand.
  router.post("/companies/:id/subscription", validateBody(activateSubscriptionSchema), async (req, res) => {
    res.status(201).json(await activateSubscription(req.user!.id, String(req.params.id), req.body));
  });

  return router;
}
