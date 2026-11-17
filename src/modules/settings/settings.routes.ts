import { Router } from "express";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { updateSettingsSchema } from "./settings.schemas.js";
import * as settings from "./settings.service.js";

export function createSettingsRouter() {
  const router = Router();
  router.use(authenticate);

  // Everyone can read them: the currency, company details and numbering are
  // needed on invoices and quotes, whoever writes them.
  router.get("/", async (req, res) => {
    res.json({ settings: await settings.getSettings(req.user!.companyId) });
  });

  router.patch("/", requirePermission("settings"), validateBody(updateSettingsSchema), async (req, res) => {
    res.json({ settings: await settings.updateSettings(req.user!.companyId, req.body) });
  });

  return router;
}
