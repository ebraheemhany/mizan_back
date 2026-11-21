import { Router } from "express";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { rawUpload } from "../files/files.routes.js";
import { fileName, removeLogo, setLogo } from "../files/files.service.js";
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

  // The logo: the image is the request body (PNG, JPEG or WebP, up to 1 MB).
  router.put("/logo", requirePermission("settings"), rawUpload, async (req, res) => {
    res.json(await setLogo(req.user!, req.body, fileName(req.headers["x-file-name"])));
  });
  router.delete("/logo", requirePermission("settings"), async (req, res) => {
    await removeLogo(req.user!);
    res.status(204).end();
  });

  return router;
}
