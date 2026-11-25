import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { fileName } from "../files/files.service.js";
import { rawUpload, sendFile } from "../files/files.routes.js";
import {
  acceptClaimSchema,
  checkoutSchema,
  claimQuerySchema,
  listClaimsQuerySchema,
  paymobAccountSchema,
  rejectClaimSchema,
  transferDetailsSchema,
} from "./collections.schemas.js";
import * as collections from "./collections.service.js";

/** /api/payment-setup — how customers can pay the company (Settings). */
export function createPaymentSetupRouter() {
  const router = Router();
  router.use(authenticate);
  // Everyone can see it (the transfer details are shown to customers anyway; the
  // Paymob secrets never leave the server). Only the owner changes it.
  const owner = requirePermission("settings");

  router.get("/", async (req, res) => {
    res.json({ setup: await collections.getSetup(req.user!.companyId) });
  });

  router.put("/transfer", owner, validateBody(transferDetailsSchema), async (req, res) => {
    res.json({ setup: await collections.saveTransferDetails(req.user!, req.body) });
  });

  router.put("/paymob", owner, validateBody(paymobAccountSchema), async (req, res) => {
    res.json({ setup: await collections.connectPaymob(req.user!, req.body) });
  });

  router.delete("/paymob", owner, async (req, res) => {
    res.json({ setup: await collections.disconnectPaymob(req.user!) });
  });

  return router;
}

/** /api/payment-claims — receipts customers sent on invoice links. */
export function createPaymentClaimsRouter() {
  const router = Router();
  router.use(authenticate);
  const record = requirePermission("recordPayments");

  router.get("/", async (req, res) => {
    const { status } = parseQuery(listClaimsQuerySchema, req.query);
    res.json({ items: await collections.listClaims(req.user!.companyId, status) });
  });

  router.get("/:id/receipt", async (req, res) => {
    sendFile(res, await collections.getClaimReceipt(req.user!.companyId, parseId(req.params.id, "Receipt")));
  });

  router.post("/:id/accept", record, validateBody(acceptClaimSchema), async (req, res) => {
    res.json({ claim: await collections.acceptClaim(req.user!, parseId(req.params.id, "Receipt"), req.body) });
  });

  router.post("/:id/reject", record, validateBody(rejectClaimSchema), async (req, res) => {
    res.json({ claim: await collections.rejectClaim(req.user!, parseId(req.params.id, "Receipt"), req.body.reason) });
  });

  return router;
}

const TOKEN = /^[\w-]{20,100}$/;

/**
 * Paying on the invoice link (no login: the token is the key):
 * POST /api/public/invoices/:token/claims — a receipt for a transfer (the file is the
 *   body; amount, date, method... in the query string)
 * POST /api/public/invoices/:token/checkout — a card payment on the company's Paymob
 * GET  /api/public/invoices/:token/checkout/:id — how that card payment ended
 */
export function createPublicPaymentRouter(limit: AuthRateLimiters) {
  const router = Router();
  router.param("token", (req, res, next, token: string) => {
    if (!TOKEN.test(token)) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Invoice not found" } });
      return;
    }
    next();
  });

  router.post("/:token/claims", limit.publicPayment, rawUpload, async (req, res) => {
    const input = parseQuery(claimQuerySchema, req.query);
    const claim = await collections.submitClaim(String(req.params.token), input, req.body, fileName(req.get("x-file-name")));
    res.status(201).json({ claim });
  });

  router.post("/:token/checkout", limit.publicPayment, validateBody(checkoutSchema), async (req, res) => {
    res.json(await collections.startOnlinePayment(String(req.params.token), req.body.locale));
  });

  router.get("/:token/checkout/:id", async (req, res) => {
    res.json(await collections.onlinePaymentStatus(String(req.params.token), parseId(req.params.id, "Payment")));
  });

  return router;
}

/** /api/public/paymob/invoices/:companyId — Paymob's callbacks for a company's own account. */
export function createInvoicePaymobWebhookRouter() {
  const router = Router();
  router.post("/:companyId", async (req, res) => {
    await collections.handlePaymobCallback(parseId(req.params.companyId, "Company"), req.body, req.query["hmac"]);
    res.json({ ok: true });
  });
  return router;
}
