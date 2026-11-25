import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { createPaymentSchema, listPaymentsQuerySchema } from "./payments.schemas.js";
import * as payments from "./payments.service.js";
import { attachPaymentProof, getPaymentProof } from "../collections/collections.service.js";
import { fileName } from "../files/files.service.js";
import { rawUpload, sendFile } from "../files/files.routes.js";

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

  // Proof of a payment (a receipt or transfer screenshot): the file is the body.
  router.put("/:id/proof", record, rawUpload, async (req, res) => {
    const id = parseId(req.params.id, "Payment");
    res.json(await attachPaymentProof(req.user!, id, req.body, fileName(req.get("x-file-name"))));
  });

  router.get("/:id/proof", async (req, res) => {
    sendFile(res, await getPaymentProof(req.user!.companyId, parseId(req.params.id, "Payment")));
  });

  return router;
}
