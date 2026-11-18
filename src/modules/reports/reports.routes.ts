import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery } from "../../middleware/validate.js";
import { periodQuerySchema, statementQuerySchema } from "./reports.schemas.js";
import * as reports from "./reports.service.js";

export function createReportsRouter() {
  const router = Router();
  // Financial reports are for the roles with the "reports" permission (owner + accountant).
  router.use(authenticate, requirePermission("reports"));

  router.get("/summary", async (req, res) => {
    const { period } = parseQuery(periodQuerySchema, req.query);
    res.json({ summary: await reports.summary(req.user!.companyId, period) });
  });

  router.get("/aging", async (req, res) => {
    res.json({ aging: await reports.aging(req.user!.companyId) });
  });

  router.get("/vat", async (req, res) => {
    const { period } = parseQuery(periodQuerySchema, req.query);
    res.json({ vat: await reports.vatReport(req.user!.companyId, period) });
  });

  router.get("/statement", async (req, res) => {
    const query = parseQuery(statementQuerySchema, req.query);
    const customerId = parseId(query.customerId, "Customer");
    res.json({ statement: await reports.statement(req.user!.companyId, customerId, query.period) });
  });

  return router;
}
