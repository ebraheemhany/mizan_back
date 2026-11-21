import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { createPaymentSchema, listPaymentsQuerySchema } from "./payments.schemas.js";
import * as payments from "./payments.service.js";

export function createPaymentsRouter() {
  const router = Router();
  router.use(authenticate);

  // Every role can see payments; recording, clearing and removing them is for
  // the roles that record payments (owner + accountant).
  const record = requirePermission("recordPayments");

  router.get("/", async (req, res) => {
    res.json(await payments.listPayments(req.user!.companyId, parseQuery(listPaymentsQuerySchema, req.query)));
  });

  router.get("/stats", async (req, res) => {
    res.json({ stats: await payments.paymentStats(req.user!.companyId) });
  });

  router.get("/export", async (req, res) => {
    const query = parseQuery(listPaymentsQuerySchema, req.query);
    res.json({ items: await payments.exportPayments(req.user!.companyId, query) });
  });

  router.get("/open-invoices", async (req, res) => {
    res.json({ invoices: await payments.openInvoices(req.user!.companyId) });
  });

  router.post("/", record, validateBody(createPaymentSchema), async (req, res) => {
    res.status(201).json({ payment: await payments.createPayment(req.user!, req.body) });
  });

  router.post("/:id/clear", record, async (req, res) => {
    res.json({ payment: await payments.clearPayment(req.user!, parseId(req.params.id, "Payment")) });
  });

  // The bank returned a pending cheque.
  router.post("/:id/bounce", record, async (req, res) => {
    res.json({ payment: await payments.bouncePayment(req.user!, parseId(req.params.id, "Payment")) });
  });

  router.delete("/:id", record, async (req, res) => {
    await payments.removePayment(req.user!, parseId(req.params.id, "Payment"));
    res.status(204).end();
  });

  return router;
}
