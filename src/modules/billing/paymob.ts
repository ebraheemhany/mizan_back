// Paymob (Egypt): the hosted checkout that saves the card, charging that card for
// renewals (MIT, through a MOTO integration), and checking the callbacks' HMAC.
// Docs: developers.paymob.com/paymob-docs/developers (intention-apis/create-intention,
// pay-with-saved-cards/mit, webhook-callbacks-and-hmac/hmac).
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

export type Payer = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

export type PaymentRequest = {
  /** Our payment id: comes back in the callback as order.merchant_order_id. */
  reference: string;
  amountCents: number;
  description: string;
  payer: Payer;
};

export type ChargeResult = {
  /** Paymob's order id (empty if it never got that far). */
  orderId: string;
  status: "paid" | "failed" | "pending";
  transactionId?: string | undefined;
  reason?: string | undefined;
};

export interface Gateway {
  /** false: the local test checkout (no Paymob keys, outside production). */
  live: boolean;
  /** A page where the customer pays (and saves the card). */
  createCheckout(request: PaymentRequest & { returnUrl: string }): Promise<{ url: string; orderId: string }>;
  /**
   * Charges a saved card with nobody present (renewals). onOrder gets Paymob's order id
   * before the charge, so its callback can always be matched to the payment.
   */
  chargeCard(
    request: PaymentRequest & { cardToken: string },
    onOrder: (orderId: string) => Promise<void>,
  ): Promise<ChargeResult>;
}

export const paymobConfigured = () =>
  Boolean(
    config.PAYMOB_SECRET_KEY &&
    config.PAYMOB_PUBLIC_KEY &&
    config.PAYMOB_HMAC_SECRET &&
    config.PAYMOB_CARD_INTEGRATION_ID,
  );

const gatewayError = () =>
  new AppError(502, "PAYMENT_GATEWAY_ERROR", "The payment service didn't answer; try again in a few minutes");

/** Paymob when its keys are set; the test checkout in development and tests. */
export function gateway(): Gateway {
  if (paymobConfigured()) return paymob;
  if (config.NODE_ENV === "production") {
    throw new AppError(503, "BILLING_UNAVAILABLE", "Payments aren't set up yet");
  }
  return testGateway;
}

// ---------------------------------------------------------------------------
// Paymob
// ---------------------------------------------------------------------------

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(path, config.PAYMOB_API_URL), {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    logger.error({ err, path }, "Could not reach Paymob");
    throw gatewayError();
  }
  const body = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || body === null) {
    logger.error({ status: res.status, path, body: JSON.stringify(body).slice(0, 500) }, "Paymob refused a request");
    throw gatewayError();
  }
  return body;
}

type Intention = {
  id: string;
  client_secret: string;
  intention_order_id: number;
  payment_keys?: { integration: number; key: string }[];
};

/** POST /v1/intention/: the payment to make, with which integration (card or MOTO). */
function createIntention(integrationId: number, request: PaymentRequest, returnUrl?: string) {
  const { payer } = request;
  return call<Intention>("/v1/intention/", {
    method: "POST",
    headers: {
      Authorization: `Token ${config.PAYMOB_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: request.amountCents,
      currency: "EGP",
      payment_methods: [integrationId],
      items: [
        {
          name: request.description,
          amount: request.amountCents,
          description: request.description,
          quantity: 1,
        },
      ],
      billing_data: {
        first_name: payer.firstName,
        last_name: payer.lastName,
        email: payer.email,
        phone_number: payer.phone,
        apartment: "NA",
        floor: "NA",
        street: "NA",
        building: "NA",
        city: "NA",
        state: "NA",
        country: "EG",
      },
      special_reference: request.reference,
      // The checkout page works for an hour.
      expiration: 3600,
      notification_url: new URL("/api/public/paymob/webhook", config.API_URL).toString(),
      ...(returnUrl ? { redirection_url: returnUrl } : {}),
    }),
  });
}

type PayResponse = {
  id?: number | string;
  success?: boolean;
  pending?: boolean;
  data?: { message?: string };
};

const paymob: Gateway = {
  live: true,

  async createCheckout(request) {
    const intention = await createIntention(config.PAYMOB_CARD_INTEGRATION_ID!, request, request.returnUrl);
    const url = new URL(config.PAYMOB_CHECKOUT_URL);
    url.searchParams.set("publicKey", config.PAYMOB_PUBLIC_KEY!);
    url.searchParams.set("clientSecret", intention.client_secret);
    return {
      url: url.toString(),
      orderId: String(intention.intention_order_id),
    };
  },

  async chargeCard(request, onOrder) {
    if (!config.PAYMOB_MOTO_INTEGRATION_ID) {
      logger.error("PAYMOB_MOTO_INTEGRATION_ID is not set: saved cards can't be charged");
      return {
        orderId: "",
        status: "failed",
        reason: "Automatic charges aren't set up",
      };
    }
    const intention = await createIntention(config.PAYMOB_MOTO_INTEGRATION_ID, request);
    const orderId = String(intention.intention_order_id);
    await onOrder(orderId);
    const paymentToken = intention.payment_keys?.[0]?.key;
    if (!paymentToken) throw gatewayError();
    const pay = await call<PayResponse>("/api/acceptance/payments/pay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { identifier: request.cardToken, subtype: "TOKEN" },
        payment_token: paymentToken,
      }),
    });
    const transactionId = pay.id === undefined ? undefined : String(pay.id);
    if (pay.pending === true) return { orderId, status: "pending", transactionId };
    if (pay.success === true) return { orderId, status: "paid", transactionId };
    return {
      orderId,
      status: "failed",
      transactionId,
      reason: String(pay.data?.message ?? "Declined").slice(0, 200),
    };
  },
};

// ---------------------------------------------------------------------------
// The test gateway (development without keys, and tests)
// ---------------------------------------------------------------------------

/** A saved test card whose token contains this is declined on renewal. */
export const DECLINED_TEST_CARD = "test-card-declined";

const testGateway: Gateway = {
  live: false,

  async createCheckout(request) {
    return {
      url: new URL(`/api/billing/test-checkout/${request.reference}`, config.API_URL).toString(),
      orderId: `test-${request.reference}`,
    };
  },

  async chargeCard(request, onOrder) {
    const orderId = `test-${request.reference}`;
    await onOrder(orderId);
    if (request.cardToken.includes(DECLINED_TEST_CARD))
      return { orderId, status: "failed", reason: "Declined (test card)" };
    return { orderId, status: "paid", transactionId: `test-${Date.now()}` };
  },
};

// ---------------------------------------------------------------------------
// Callback HMAC (SHA-512 of chosen fields' values, in this order, joined with nothing)
// ---------------------------------------------------------------------------

const TRANSACTION_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

const TOKEN_FIELDS = ["card_subtype", "created_at", "email", "id", "masked_pan", "merchant_id", "order_id", "token"];

export type CallbackType = "TRANSACTION" | "TOKEN";

function valueAt(obj: unknown, path: string) {
  const value = path
    .split(".")
    .reduce<unknown>(
      (at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined),
      obj,
    );
  return value === null || value === undefined ? "" : String(value);
}

/** The HMAC Paymob sends with a callback of this type (also used to sign test callbacks). */
export function callbackHmac(type: CallbackType, obj: unknown, secret = config.PAYMOB_HMAC_SECRET ?? "") {
  const fields = type === "TRANSACTION" ? TRANSACTION_FIELDS : TOKEN_FIELDS;
  return createHmac("sha512", secret)
    .update(fields.map((field) => valueAt(obj, field)).join(""))
    .digest("hex");
}

/** Whether a callback really comes from Paymob (the hmac arrives in the query string). */
export function verifyCallback(type: CallbackType, obj: unknown, hmac: unknown) {
  if (!config.PAYMOB_HMAC_SECRET || typeof hmac !== "string" || !obj || typeof obj !== "object") return false;
  const expected = Buffer.from(callbackHmac(type, obj), "utf8");
  const given = Buffer.from(hmac.toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
