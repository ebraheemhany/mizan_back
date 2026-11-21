import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { locale } from "../auth/auth.schemas.js";
import * as billing from "./billing.service.js";
import { paymobConfigured, verifyCallback } from "./paymob.js";

const checkoutSchema = z.object({ plan: z.enum(["pro", "business"]), locale });
const downgradeSchema = z.object({ plan: z.enum(["pro"]) });

/** /api/billing: every role reads the plan and its limits; only the owner pays or changes it. */
export function createBillingRouter() {
  const router = Router();
  router.use(authenticate);
  const owner = requirePermission("settings");

  router.get("/", async (req, res) => {
    res.json({ billing: await billing.getBilling(req.user!.companyId) });
  });

  router.get("/payments", owner, async (req, res) => {
    res.json({ items: await billing.listPayments(req.user!.companyId) });
  });

  router.get("/payments/:id", owner, async (req, res) => {
    res.json({
      payment: await billing.getPayment(req.user!.companyId, String(req.params.id)),
    });
  });

  router.post("/checkout", owner, validateBody(checkoutSchema), async (req, res) => {
    res.status(201).json(await billing.startCheckout(req.user!, req.body.plan, req.body.locale));
  });

  router.post("/downgrade", owner, validateBody(downgradeSchema), async (req, res) => {
    res.json({
      billing: await billing.scheduleDowngrade(req.user!, req.body.plan),
    });
  });

  router.post("/cancel", owner, async (req, res) => {
    res.json({ billing: await billing.cancelSubscription(req.user!) });
  });

  router.post("/resume", owner, async (req, res) => {
    res.json({ billing: await billing.resumeSubscription(req.user!) });
  });

  return router;
}

/**
 * /api/public/paymob/webhook: Paymob's callbacks (no login; trusted only with a
 * valid HMAC). "TRANSACTION" says how a payment ended; "TOKEN" brings the saved card.
 */
export function createPaymobWebhookRouter() {
  const router = Router();

  router.post("/webhook", async (req, res) => {
    const { type, obj } = (req.body ?? {}) as {
      type?: string;
      obj?: Record<string, unknown>;
    };
    if (type !== "TRANSACTION" && type !== "TOKEN") {
      res.json({ ok: true });
      return;
    }
    if (!verifyCallback(type, obj, req.query["hmac"])) {
      throw new AppError(401, "INVALID_SIGNATURE", "The callback's signature doesn't match");
    }

    if (type === "TOKEN") {
      await billing.saveCard(String(obj!["order_id"]), {
        token: String(obj!["token"]),
        masked: String(obj!["masked_pan"] ?? ""),
        brand: String(obj!["card_subtype"] ?? ""),
      });
    } else if (obj!["pending"] !== true) {
      // A final answer (a pending one is followed by another callback).
      // Matched by Paymob's order id, which the HMAC covers (merchant_order_id isn't signed).
      const order = (obj!["order"] ?? {}) as { id?: unknown };
      const orderId = order.id === undefined || order.id === null ? null : String(order.id);
      const payment = orderId
        ? await prisma.billingPayment.findUnique({
            where: { gatewayOrderId: orderId },
            select: { id: true },
          })
        : null;
      if (payment && orderId) {
        const paymentId = payment.id;
        const data = (obj!["data"] ?? {}) as { message?: unknown };
        await billing.settlePayment(paymentId, {
          paid:
            obj!["success"] === true &&
            obj!["is_voided"] !== true &&
            obj!["is_refunded"] !== true &&
            obj!["error_occured"] !== true,
          transactionId: obj!["id"] === undefined ? undefined : String(obj!["id"]),
          reason: typeof data.message === "string" ? data.message : undefined,
          amountCents: Number(obj!["amount_cents"]),
          orderId,
        });
      }
    }
    // Always "received" once the signature is good: Paymob doesn't need to retry.
    res.json({ ok: true });
  });

  return router;
}

// ---------------------------------------------------------------------------
// The local test checkout (development without Paymob keys, and tests)
// ---------------------------------------------------------------------------

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Stands in for Paymob's page: pay or decline, with or without saving the card. Never in production. */
export function createTestCheckoutRouter() {
  const router = Router();
  router.use((_req, _res, next) => {
    if (paymobConfigured() || config.NODE_ENV === "production") throw notFound("Page");
    next();
  });

  router.get("/:id", async (req, res) => {
    const payment = await prisma.billingPayment.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!payment || payment.status !== "pending" || payment.automatic) throw notFound("Payment");
    const app = new URL(config.APP_URL).origin;
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${app}`,
    );
    res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>دفع تجريبي</title></head>
<body style="font-family:Tahoma,Arial,sans-serif;background:#f1f4f3;margin:0;padding:32px 16px">
<form method="post" style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e2e8e5;border-radius:16px;padding:24px">
<p style="margin:0;color:#b45309;font-size:13px;font-weight:bold">صفحة دفع تجريبية: مفيش فلوس حقيقية بتتخصم (مفاتيح Paymob لسه ما اتحطتش)</p>
<h1 style="font-size:20px;margin:16px 0 8px">باقة ${esc(payment.plan)}</h1>
<p style="font-size:28px;font-weight:bold;margin:0 0 16px" dir="ltr">${esc(payment.amount.toFixed(2))} EGP</p>
<label style="display:flex;gap:8px;align-items:center;font-size:14px;margin-bottom:16px"><input type="checkbox" name="save" value="1" checked> احفظ الكارت للتجديد التلقائي</label>
<button name="outcome" value="paid" style="width:100%;height:44px;border:0;border-radius:10px;background:#047857;color:#fff;font-weight:bold;font-size:15px">ادفع (تجريبي)</button>
<button name="outcome" value="declined" style="width:100%;height:40px;margin-top:8px;border:1px solid #e2e8e5;border-radius:10px;background:#fff;color:#b91c1c;font-weight:bold">ارفض الدفع</button>
</form></body></html>`);
  });

  router.post("/:id", express.urlencoded({ extended: false }), async (req, res) => {
    const payment = await prisma.billingPayment.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!payment || payment.automatic) throw notFound("Payment");
    const paid = req.body?.outcome === "paid";
    if (paid && req.body?.save === "1" && payment.gatewayOrderId) {
      await billing.saveCard(payment.gatewayOrderId, {
        token: `test-card-${randomBytes(12).toString("hex")}`,
        masked: "xxxx-xxxx-xxxx-4242",
        brand: "Visa",
      });
    }
    await billing.settlePayment(payment.id, {
      paid,
      reason: paid ? undefined : "Declined (test)",
    });
    res.redirect(303, payment.returnUrl ?? config.APP_URL);
  });

  return router;
}
