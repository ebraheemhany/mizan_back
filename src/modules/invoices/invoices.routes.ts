import { Router } from "express";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import {
  bulkCancelSchema,
  createInvoiceSchema,
  emailInvoiceSchema,
  listInvoicesQuerySchema,
  recordPaymentSchema,
  reminderSchema,
} from "./invoices.schemas.js";
import * as invoices from "./invoices.service.js";

export function createInvoicesRouter(limit: AuthRateLimiters) {
  const router = Router();
  router.use(authenticate);

  // Every role can see invoices. Writing them and recording payments follow
  // the permission table (owner + accountant).
  const issue = requirePermission("issueInvoices");
  const pay = requirePermission("recordPayments");

  router.get("/", async (req, res) => {
    res.json(await invoices.listInvoices(req.user!.companyId, parseQuery(listInvoicesQuerySchema, req.query)));
  });

  // Fixed paths first, so they aren't mistaken for an invoice reference.
  router.get("/stats", async (req, res) => {
    res.json({ stats: await invoices.invoiceStats(req.user!.companyId) });
  });

  router.get("/export", async (req, res) => {
    const query = parseQuery(listInvoicesQuerySchema, req.query);
    res.json({ items: await invoices.exportInvoices(req.user!.companyId, query) });
  });

  router.post("/bulk-cancel", issue, validateBody(bulkCancelSchema), async (req, res) => {
    res.json(await invoices.bulkCancel(req.user!, req.body.ids));
  });

  router.post("/", issue, validateBody(createInvoiceSchema), async (req, res) => {
    res.status(201).json({ invoice: await invoices.createInvoice(req.user!, req.body) });
  });

  // :ref is the invoice id or its number (/api/invoices/1044).
  router.get("/:ref", async (req, res) => {
    res.json({ invoice: await invoices.getInvoice(req.user!.companyId, invoices.parseInvoiceRef(req.params.ref)) });
  });

  router.post("/:ref/send", issue, async (req, res) => {
    res.json({ invoice: await invoices.sendInvoice(req.user!, invoices.parseInvoiceRef(req.params.ref)) });
  });

  router.post("/:ref/cancel", issue, async (req, res) => {
    res.json({ invoice: await invoices.cancelInvoice(req.user!, invoices.parseInvoiceRef(req.params.ref)) });
  });

  router.post("/:ref/payments", pay, validateBody(recordPaymentSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.status(201).json({ invoice: await invoices.recordPayment(req.user!, ref, req.body) });
  });

  router.post("/:ref/email", issue, limit.customerEmail, validateBody(emailInvoiceSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.json({ invoice: await invoices.emailInvoice(req.user!, ref, req.body) });
  });

  router.post("/:ref/reminders", issue, limit.customerEmail, validateBody(reminderSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.status(201).json({ invoice: await invoices.recordReminder(req.user!, ref, req.body) });
  });

  return router;
}

/** GET /api/public/invoices/:token — the shareable invoice link, no login. */
export function createPublicInvoicesRouter() {
  const router = Router();
  router.get("/:token", async (req, res) => {
    const token = String(req.params.token);
    if (!/^[\w-]{20,100}$/.test(token)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Invoice not found" } });
      return;
    }
    res.json({ invoice: await invoices.getPublicInvoice(token) });
  });
  return router;
}
