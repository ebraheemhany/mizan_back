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
import { createCreditNote, creditNoteSchema, deleteCreditNote } from "./credit-notes.js";
import { parseId } from "../../lib/params.js";
import { publicPaymentOptions } from "../collections/collections.service.js";
import { notifyPayment } from "../notifications/notices.service.js";
import { fileName } from "../files/files.service.js";
import { rawUpload, sendFile } from "../files/files.routes.js";
import { addAttachment, getAttachment, listAttachments, removeAttachment } from "./attachments.js";

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

  // Credit notes: by whoever records payments; taken back by the owner.
  router.post("/:ref/credit-notes", pay, validateBody(creditNoteSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.status(201).json({ invoice: await createCreditNote(req.user!, ref, req.body) });
  });

  router.delete("/:ref/credit-notes/:id", requirePermission("deleteData"), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.json({ invoice: await deleteCreditNote(req.user!, ref, parseId(req.params.id, "Credit note")) });
  });

  router.post("/:ref/payments", pay, validateBody(recordPaymentSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    // The new payment's id too, so its proof can be uploaded right after.
    const paymentId = await invoices.applyPayment(req.user!, ref, req.body);
    await notifyPayment(req.user!.companyId, paymentId, req.user!.id);
    res.status(201).json({ invoice: await invoices.getInvoice(req.user!.companyId, ref), paymentId });
  });

  router.post("/:ref/email", issue, limit.customerEmail, validateBody(emailInvoiceSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.json({ invoice: await invoices.emailInvoice(req.user!, ref, req.body) });
  });

  // Files attached to the invoice (purchase order, delivery note...): everyone who sees the
  // invoice sees them; adding and removing is for whoever issues invoices. PUT adds one (the
  // file is the body, its name in X-File-Name), like the app's other uploads.
  router.get("/:ref/attachments", async (req, res) => {
    res.json({ attachments: await listAttachments(req.user!.companyId, invoices.parseInvoiceRef(req.params.ref)) });
  });

  router.put("/:ref/attachments", issue, rawUpload, async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.status(201).json({ attachment: await addAttachment(req.user!, ref, req.body, fileName(req.get("x-file-name"))) });
  });

  router.get("/:ref/attachments/:id", async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    sendFile(res, await getAttachment(req.user!.companyId, ref, parseId(req.params.id, "Attachment")));
  });

  router.delete("/:ref/attachments/:id", issue, async (req, res) => {
    await removeAttachment(req.user!, invoices.parseInvoiceRef(req.params.ref), parseId(req.params.id, "Attachment"));
    res.status(204).end();
  });

  router.post("/:ref/reminders", issue, limit.customerEmail, validateBody(reminderSchema), async (req, res) => {
    const ref = invoices.parseInvoiceRef(req.params.ref);
    res.status(201).json({ invoice: await invoices.recordReminder(req.user!, ref, req.body) });
  });

  return router;
}

/**
 * GET /api/public/invoices/:token — the shareable invoice link, no login, with how the
 * customer can pay it (transfer details, card payment, receipts they already sent).
 */
export function createPublicInvoicesRouter() {
  const router = Router();
  router.get("/:token", async (req, res) => {
    const token = String(req.params.token);
    if (!/^[\w-]{20,100}$/.test(token)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Invoice not found" } });
      return;
    }
    const invoice = await invoices.getPublicInvoice(token);
    res.json({ invoice, pay: await publicPaymentOptions(token) });
  });
  return router;
}
