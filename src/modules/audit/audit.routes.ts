import { Router } from "express";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery } from "../../middleware/validate.js";
import { exportAuditQuerySchema, listAuditQuerySchema } from "./audit.schemas.js";
import { exportAudit, listAudit } from "./audit.service.js";

export function createAuditRouter() {
  const router = Router();
  // Who did what, with their IPs and sign-ins: the owner only.
  router.use(authenticate, requirePermission("auditLog"));

  router.get("/", async (req, res) => {
    res.json(await listAudit(req.user!.companyId, parseQuery(listAuditQuerySchema, req.query)));
  });

  router.get("/export", async (req, res) => {
    res.json(await exportAudit(req.user!.companyId, parseQuery(exportAuditQuerySchema, req.query)));
  });

  return router;
}
