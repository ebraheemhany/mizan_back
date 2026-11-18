import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import { dashboard } from "./dashboard.service.js";

export function createDashboardRouter() {
  const router = Router();
  router.get("/", authenticate, async (req, res) => {
    res.json(await dashboard(req.user!.companyId, req.user!.role));
  });
  return router;
}
