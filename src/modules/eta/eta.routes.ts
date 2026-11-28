import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { parseInvoiceRef } from "../invoices/invoices.service.js";
import * as eta from "./eta.service.js";

/** E-invoicing (ETA): the company's link (owner), and sending invoices and credit notes. */
export function createEtaRouter() {
  const router = Router();
  router.use(authenticate);
  const owner = requirePermission("settings");
  const issue = requirePermission("issueInvoices");

  router.get("/setup", owner, async (req, res) => {
    res.json({ setup: await eta.getSetup(req.user!.companyId) });
  });
  router.put("/setup", owner, validateBody(eta.etaSetupSchema), async (req, res) => {
    res.json({ setup: await eta.saveSetup(req.user!, req.body) });
  });
  router.post("/setup/verify", owner, async (req, res) => {
    res.json({ setup: await eta.verifySetup(req.user!) });
  });
  router.delete("/setup/credentials", owner, async (req, res) => {
    res.json({ setup: await eta.clearCredentials(req.user!) });
  });

  // An invoice (and its credit notes) at ETA: everyone who sees invoices; acting needs issueInvoices.
  router.get("/invoices/:ref", async (req, res) => {
    res.json(await eta.invoiceEta(req.user!.companyId, parseInvoiceRef(req.params.ref)));
  });
  router.post("/invoices/:ref/submit", issue, async (req, res) => {
    res.json({ eta: await eta.submitInvoice(req.user!, parseInvoiceRef(req.params.ref)) });
  });
  router.post("/invoices/:ref/refresh", issue, async (req, res) => {
    res.json({ eta: await eta.refreshInvoice(req.user!, parseInvoiceRef(req.params.ref)) });
  });
  router.post("/invoices/:ref/cancel", issue, validateBody(eta.cancelSchema), async (req, res) => {
    res.json({ eta: await eta.cancelInvoiceAtEta(req.user!, parseInvoiceRef(req.params.ref), req.body.reason) });
  });

  router.post("/invoices/:ref/credit-notes/:id/submit", issue, async (req, res) => {
    const id = parseId(req.params.id, "Credit note");
    res.json({ eta: await eta.submitCreditNote(req.user!, parseInvoiceRef(req.params.ref), id) });
  });
  router.post("/invoices/:ref/credit-notes/:id/refresh", issue, async (req, res) => {
    const id = parseId(req.params.id, "Credit note");
    res.json({ eta: await eta.refreshCreditNote(req.user!, parseInvoiceRef(req.params.ref), id) });
  });
  router.post("/invoices/:ref/credit-notes/:id/cancel", issue, validateBody(eta.cancelSchema), async (req, res) => {
    const id = parseId(req.params.id, "Credit note");
    res.json({ eta: await eta.cancelCreditNoteAtEta(req.user!, parseInvoiceRef(req.params.ref), id, req.body.reason) });
  });

  return router;
}
