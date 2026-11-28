import { randomUUID } from "node:crypto";
import { Prisma, type PaymentMethod } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { money, moneyString } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { open, seal } from "../../lib/secret-box.js";
import { audit } from "../audit/audit.service.js";
import { createAccountCheckout, readTransaction, verifyCallback, type CallbackType } from "../billing/paymob.js";
import type { Locale } from "../email/templates.js";
import { notifyPayment } from "../notifications/notices.service.js";
import { checkUpload } from "../files/files.service.js";
import { applyPaymentTx, paymentNumber } from "../invoices/invoices.service.js";
import type { ClaimInput, PaymobAccountInput, TransferDetailsInput } from "./collections.schemas.js";

// Collecting invoice payments from the company's customers, on the invoice link:
// - transfers made outside Mizan, reported with a receipt, wait for review;
// - card payments go through the company's own Paymob account and record themselves.

type Actor = { id: string; companyId: string };
type Tx = Prisma.TransactionClient;

/** Invoices a customer can still pay (overdue ones are sent/partial too). */
const PAYABLE = ["sent", "partial"] as const;
/** Receipts waiting for review on one invoice, at most (the link is public). */
const MAX_PENDING_CLAIMS = 3;

// ---------------------------------------------------------------------------
// The company's setup
// ---------------------------------------------------------------------------

const TRANSFER_FIELDS = ["bankName", "accountName", "accountNumber", "instapayAddress", "walletNumber", "instructions"] as const;

type SetupRow = Prisma.PaymentSetupGetPayload<object>;

function transferOf(setup: SetupRow | null) {
  const details = Object.fromEntries(TRANSFER_FIELDS.map((key) => [key, setup?.[key] ?? null])) as Record<
    (typeof TRANSFER_FIELDS)[number],
    string | null
  >;
  return details;
}

const hasTransfer = (setup: SetupRow | null) => TRANSFER_FIELDS.some((key) => key !== "instructions" && setup?.[key]);

function paymobOf(setup: SetupRow | null) {
  const connected = Boolean(setup?.paymobSecretKey && setup.paymobPublicKey && setup.paymobHmacSecret && setup.paymobIntegrationId);
  return {
    connected,
    live: connected ? setup!.paymobLive : false,
    publicKey: connected ? setup!.paymobPublicKey : null,
    integrationId: connected ? setup!.paymobIntegrationId : null,
    connectedAt: connected ? setup!.paymobConnectedAt?.toISOString() ?? null : null,
  };
}

/** What Settings shows: the transfer details, and whether Paymob is connected (never the secrets). */
export async function getSetup(companyId: string) {
  const setup = await prisma.paymentSetup.findUnique({ where: { companyId } });
  return { transfer: transferOf(setup), paymob: paymobOf(setup) };
}

export async function saveTransferDetails(actor: Actor, input: TransferDetailsInput) {
  const data = Object.fromEntries(TRANSFER_FIELDS.map((key) => [key, input[key] ?? null]));
  await prisma.$transaction(async (tx) => {
    await tx.paymentSetup.upsert({ where: { companyId: actor.companyId }, create: { companyId: actor.companyId, ...data }, update: data });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "paymentDetailsUpdated",
      item: { type: "company", id: actor.companyId },
      values: { fields: TRANSFER_FIELDS.filter((key) => input[key]).join(", ") },
    });
  });
  return getSetup(actor.companyId);
}

const webhookUrl = (companyId: string) => new URL(`/api/public/paymob/invoices/${companyId}`, config.API_URL).toString();

/**
 * Connects the company's Paymob account. The keys are tried first with a 1 EGP checkout
 * that nobody pays (Paymob only answers for keys and an integration that work together),
 * so a wrong key or integration ID is caught here, not when a customer tries to pay.
 */
export async function connectPaymob(actor: Actor, input: PaymobAccountInput) {
  await createAccountCheckout(input, {
    reference: `mizan-check-${randomUUID()}`,
    amountCents: 100,
    description: "Mizan connection check",
    payer: { firstName: "Mizan", lastName: "Check", email: "check@example.com", phone: "+201000000000" },
    notificationUrl: webhookUrl(actor.companyId),
  });
  const live = input.secretKey.startsWith("egy_sk_live_");
  const data = {
    paymobSecretKey: seal(input.secretKey),
    paymobPublicKey: input.publicKey,
    paymobHmacSecret: seal(input.hmacSecret),
    paymobIntegrationId: input.integrationId,
    paymobLive: live,
    paymobConnectedAt: new Date(),
  };
  await prisma.$transaction(async (tx) => {
    await tx.paymentSetup.upsert({ where: { companyId: actor.companyId }, create: { companyId: actor.companyId, ...data }, update: data });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "paymobConnected",
      item: { type: "company", id: actor.companyId },
      values: { live },
    });
  });
  return getSetup(actor.companyId);
}

export async function disconnectPaymob(actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.paymentSetup.updateMany({
      where: { companyId: actor.companyId, paymobSecretKey: { not: null } },
      data: {
        paymobSecretKey: null,
        paymobPublicKey: null,
        paymobHmacSecret: null,
        paymobIntegrationId: null,
        paymobLive: false,
        paymobConnectedAt: null,
      },
    });
    if (count > 0) {
      await audit(tx, actor.companyId, { action: "settings", event: "paymobDisconnected", item: { type: "company", id: actor.companyId } });
    }
  });
  return getSetup(actor.companyId);
}

// ---------------------------------------------------------------------------
// The invoice link (no login: found by its secret token)
// ---------------------------------------------------------------------------

const publicInvoiceSelect = {
  id: true,
  companyId: true,
  number: true,
  numberPrefix: true,
  status: true,
  issueDate: true,
  total: true,
  amountPaid: true,
  credited: true,
  customerName: true,
  customerEmail: true,
  customerPhone: true,
  publicToken: true,
  company: { select: { name: true, currency: true, paymentSetup: true } },
} satisfies Prisma.InvoiceSelect;

async function findByToken(db: Tx | typeof prisma, token: string) {
  const invoice = await db.invoice.findFirst({
    where: { publicToken: token, status: { not: "draft" } },
    select: publicInvoiceSelect,
  });
  if (!invoice) throw notFound("Invoice");
  return invoice;
}

type PublicInvoice = Awaited<ReturnType<typeof findByToken>>;

const remainingOf = (invoice: PublicInvoice) => invoice.total.minus(invoice.amountPaid).minus(invoice.credited);
const isPayable = (invoice: PublicInvoice) =>
  (PAYABLE as readonly string[]).includes(invoice.status) && remainingOf(invoice).greaterThan(0);

function onlineAvailable(invoice: PublicInvoice) {
  return paymobOf(invoice.company.paymentSetup).connected && invoice.company.currency === "EGP" && isPayable(invoice);
}

const claimPublicDto = (c: {
  id: string;
  amount: Prisma.Decimal;
  date: Date;
  method: PaymentMethod;
  status: string;
  rejectReason: string | null;
  createdAt: Date;
}) => ({
  id: c.id,
  amount: moneyString(c.amount),
  date: toIso(c.date),
  method: c.method,
  status: c.status,
  rejectReason: c.rejectReason,
  createdAt: c.createdAt.toISOString(),
});

/** How the customer can pay this invoice, and the receipts they already sent. */
export async function publicPaymentOptions(token: string) {
  const invoice = await findByToken(prisma, token);
  const setup = invoice.company.paymentSetup;
  const claims = await prisma.paymentClaim.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, amount: true, date: true, method: true, status: true, rejectReason: true, createdAt: true },
  });
  return {
    payable: isPayable(invoice),
    remaining: moneyString(remainingOf(invoice)),
    online: onlineAvailable(invoice) ? { test: !setup!.paymobLive } : null,
    transfer: hasTransfer(setup) ? transferOf(setup) : null,
    claims: claims.map(claimPublicDto),
  };
}

/** A customer reports a transfer made outside Mizan, with the receipt (required). */
export async function submitClaim(token: string, input: ClaimInput, body: unknown, fileName: string | null) {
  const { data, contentType } = checkUpload("receipt", body);
  const invoice = await findByToken(prisma, token);
  if (!isPayable(invoice)) {
    throw new AppError(409, "INVOICE_NOT_PAYABLE", "This invoice has nothing left to pay");
  }
  const amount = money(input.amount);
  if (amount.greaterThan(remainingOf(invoice))) {
    throw new AppError(400, "PAYMENT_EXCEEDS_BALANCE", "The amount is more than what is still owed", { field: "amount" });
  }
  if (input.date > businessToday()) {
    throw new AppError(400, "PAYMENT_DATE_IN_FUTURE", "The payment date can't be in the future", { field: "date" });
  }
  if (input.date < toIso(invoice.issueDate)) {
    throw new AppError(400, "PAYMENT_BEFORE_ISSUE", "The payment date can't be before the invoice date", { field: "date" });
  }

  const claim = await prisma.$transaction(async (tx) => {
    const pending = await tx.paymentClaim.count({ where: { invoiceId: invoice.id, status: "pending" } });
    if (pending >= MAX_PENDING_CLAIMS) {
      throw new AppError(429, "CLAIMS_LIMIT", "Receipts already wait for review on this invoice");
    }
    const file = await tx.storedFile.create({
      data: { kind: "receipt", contentType, size: data.length, name: fileName, data: new Uint8Array(data), companyId: invoice.companyId },
      select: { id: true },
    });
    const created = await tx.paymentClaim.create({
      data: {
        amount,
        date: toDate(input.date),
        method: input.method,
        reference: input.reference ?? null,
        payerName: input.payerName ?? null,
        note: input.note ?? null,
        companyId: invoice.companyId,
        invoiceId: invoice.id,
        receiptFileId: file.id,
      },
      select: { id: true, amount: true, date: true, method: true, status: true, rejectReason: true, createdAt: true },
    });
    await tx.invoiceEvent.create({
      data: { invoiceId: invoice.id, type: "paymentClaimed", values: { amount: moneyString(amount), method: input.method } },
    });
    await audit(tx, invoice.companyId, {
      action: "payment",
      event: "paymentClaimSubmitted",
      item: { type: "invoice", id: invoice.id, ref: `${invoice.numberPrefix}${invoice.number}` },
      values: { amount: moneyString(amount), method: input.method, customer: invoice.customerName },
    });
    return created;
  });
  return claimPublicDto(claim);
}

/** The company's Paymob account, ready to use (the secrets opened). */
function accountOf(setup: SetupRow) {
  return {
    secretKey: open(setup.paymobSecretKey!),
    publicKey: setup.paymobPublicKey!,
    hmacSecret: open(setup.paymobHmacSecret!),
    integrationId: setup.paymobIntegrationId!,
  };
}

/** Starts a card payment of what is still owed, on the company's own Paymob account. */
export async function startOnlinePayment(token: string, locale: Locale) {
  const invoice = await findByToken(prisma, token);
  if (!onlineAvailable(invoice)) {
    throw new AppError(409, "ONLINE_PAYMENT_UNAVAILABLE", "Paying online isn't available for this invoice");
  }
  const amount = remainingOf(invoice);
  const id = randomUUID();
  const [firstName, ...rest] = invoice.customerName.trim().split(/\s+/);
  const checkout = await createAccountCheckout(accountOf(invoice.company.paymentSetup!), {
    reference: id,
    amountCents: Number(amount.times(100).toFixed(0)),
    description: `${invoice.company.name} - ${invoice.numberPrefix}${invoice.number}`.slice(0, 200),
    payer: {
      firstName: firstName || "Customer",
      lastName: rest.join(" ") || firstName || "Customer",
      email: invoice.customerEmail ?? "customer@example.com",
      phone: invoice.customerPhone ?? "+201000000000",
    },
    notificationUrl: webhookUrl(invoice.companyId),
    returnUrl: new URL(`/${locale}/i/${token}?checkout=${id}`, config.APP_URL).toString(),
  });
  await prisma.onlinePayment.create({
    data: { id, amount, gatewayOrderId: checkout.orderId, companyId: invoice.companyId, invoiceId: invoice.id },
  });
  return { url: checkout.url };
}

/** Where a card payment started on this link stands (the page asks after Paymob sends the customer back). */
export async function onlinePaymentStatus(token: string, id: string) {
  const invoice = await findByToken(prisma, token);
  const payment = await prisma.onlinePayment.findFirst({
    where: { id, invoiceId: invoice.id },
    select: { status: true, amount: true },
  });
  if (!payment) throw notFound("Payment");
  return { status: payment.status, amount: moneyString(payment.amount) };
}

// ---------------------------------------------------------------------------
// Paymob's callback for a company's account
// ---------------------------------------------------------------------------

/**
 * POST /api/public/paymob/invoices/:companyId. Trusted only with a valid HMAC made
 * with that company's secret. A paid transaction records the payment (nobody's
 * name on it: the customer paid on the link).
 */
export async function handlePaymobCallback(companyId: string, body: unknown, hmac: unknown) {
  const { type, obj } = (body ?? {}) as { type?: string; obj?: Record<string, unknown> };
  if (type !== "TRANSACTION" && type !== "TOKEN") return;
  const setup = await prisma.paymentSetup.findUnique({ where: { companyId } });
  const secret = setup?.paymobHmacSecret ? open(setup.paymobHmacSecret) : null;
  if (!secret || !verifyCallback(type as CallbackType, obj, hmac, secret)) {
    throw new AppError(401, "INVALID_SIGNATURE", "The callback's signature doesn't match");
  }
  // Saved cards aren't used for invoices.
  if (type !== "TRANSACTION") return;

  const tx = readTransaction(obj!);
  if (!tx.final || !tx.orderId) return;
  const online = await prisma.onlinePayment.findUnique({
    where: { companyId_gatewayOrderId: { companyId, gatewayOrderId: tx.orderId } },
    select: { id: true, status: true, amount: true, invoiceId: true },
  });
  // Not one of ours (e.g. the connection check), or already settled (Paymob retries).
  if (!online || online.status !== "pending") return;

  if (!tx.paid) {
    await prisma.onlinePayment.updateMany({
      where: { id: online.id, status: "pending" },
      data: { status: "failed", failureReason: tx.reason?.slice(0, 200) ?? "Declined", transactionId: tx.transactionId ?? null, settledAt: new Date() },
    });
    return;
  }
  // The amount Paymob charged must be the one asked for.
  if (Number(obj!["amount_cents"]) !== Number(online.amount.times(100).toFixed(0))) {
    logger.error({ companyId, orderId: tx.orderId }, "Paymob charged a different amount than the checkout asked for");
    await markPaidUnrecorded(online.id, tx.transactionId, "AMOUNT_MISMATCH");
    return;
  }

  try {
    const recorded = await prisma.$transaction(async (db) => {
      const { count } = await db.onlinePayment.updateMany({
        where: { id: online.id, status: "pending" },
        data: { status: "paid", transactionId: tx.transactionId ?? null, settledAt: new Date() },
      });
      if (count === 0) return null;
      const paymentId = await applyPaymentTx(db, { id: null, companyId }, { id: online.invoiceId }, {
        amount: online.amount.toFixed(2),
        date: businessToday(),
        method: "card",
        account: "bank",
        reference: tx.transactionId ?? null,
        note: "Paymob",
      });
      await db.onlinePayment.update({ where: { id: online.id }, data: { paymentId } });
      return paymentId;
    });
    // The customer paid: the team hears (nobody recorded it, so everyone does).
    if (recorded) await notifyPayment(companyId, recorded, null);
  } catch (err) {
    // Paid, but it can't be recorded (the invoice was paid another way meanwhile, or
    // its month is closed): kept as paid with the reason, for someone to sort out.
    if (!(err instanceof AppError)) throw err;
    logger.error({ companyId, orderId: tx.orderId, code: err.code }, "A paid online payment couldn't be recorded");
    await markPaidUnrecorded(online.id, tx.transactionId, err.code);
  }
}

async function markPaidUnrecorded(id: string, transactionId: string | undefined, reason: string) {
  await prisma.onlinePayment.updateMany({
    where: { id, status: "pending" },
    data: { status: "paid", transactionId: transactionId ?? null, failureReason: reason, settledAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Reviewing customers' receipts
// ---------------------------------------------------------------------------

const claimSelect = {
  id: true,
  amount: true,
  date: true,
  method: true,
  reference: true,
  payerName: true,
  note: true,
  status: true,
  rejectReason: true,
  createdAt: true,
  reviewedAt: true,
  receipt: { select: { contentType: true, name: true } },
  invoice: { select: { id: true, number: true, numberPrefix: true, customerName: true } },
} satisfies Prisma.PaymentClaimSelect;

type ClaimRow = Prisma.PaymentClaimGetPayload<{ select: typeof claimSelect }>;

const claimDto = (c: ClaimRow) => ({
  id: c.id,
  amount: moneyString(c.amount),
  date: toIso(c.date),
  method: c.method,
  reference: c.reference,
  payerName: c.payerName,
  note: c.note,
  status: c.status,
  rejectReason: c.rejectReason,
  createdAt: c.createdAt.toISOString(),
  reviewedAt: c.reviewedAt?.toISOString() ?? null,
  receipt: c.receipt,
  invoice: {
    id: c.invoice.id,
    number: c.invoice.number,
    displayNumber: `${c.invoice.numberPrefix}${c.invoice.number}`,
    customer: c.invoice.customerName,
  },
});

export async function listClaims(companyId: string, status: "pending" | "accepted" | "rejected" | "all") {
  const rows = await prisma.paymentClaim.findMany({
    where: { companyId, ...(status === "all" ? {} : { status }) },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: claimSelect,
  });
  return rows.map(claimDto);
}

async function findClaim(db: Tx | typeof prisma, companyId: string, id: string) {
  const claim = await db.paymentClaim.findFirst({
    where: { id, companyId },
    select: { ...claimSelect, receiptFileId: true, invoiceId: true },
  });
  if (!claim) throw notFound("Receipt");
  return claim;
}

const alreadyReviewed = () => new AppError(409, "CLAIM_ALREADY_REVIEWED", "This receipt was already reviewed");

/** Where a transfer of this kind lands, unless the reviewer says otherwise. */
const DEFAULT_ACCOUNT: Partial<Record<PaymentMethod, "bank" | "wallet">> = { bank: "bank", instapay: "bank", vodafoneCash: "wallet" };

/** Accepts a receipt: the payment is recorded (with the receipt as its proof) and the claim closed, together. */
export async function acceptClaim(actor: Actor, id: string, input: { account?: "bank" | "cashbox" | "wallet" | undefined }) {
  const claim = await findClaim(prisma, actor.companyId, id);
  if (claim.status !== "pending") throw alreadyReviewed();
  const paymentId = await prisma.$transaction(async (tx) => {
    const paymentId = await applyPaymentTx(tx, actor, { id: claim.invoiceId }, {
      amount: claim.amount.toFixed(2),
      date: toIso(claim.date),
      method: claim.method,
      account: input.account ?? DEFAULT_ACCOUNT[claim.method] ?? "bank",
      reference: claim.reference,
      note: claim.note,
    });
    // Only if still pending (two reviewers at once: one wins, the other's payment rolls back).
    const { count } = await tx.paymentClaim.updateMany({
      where: { id: claim.id, status: "pending" },
      data: { status: "accepted", paymentId, reviewedAt: new Date(), reviewedById: actor.id },
    });
    if (count === 0) throw alreadyReviewed();
    await tx.invoicePayment.update({ where: { id: paymentId }, data: { proofFileId: claim.receiptFileId } });
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "paymentClaimAccepted",
      item: { type: "invoice", id: claim.invoice.id, ref: `${claim.invoice.numberPrefix}${claim.invoice.number}` },
      values: { amount: moneyString(claim.amount), method: claim.method, customer: claim.invoice.customerName },
    });
    return paymentId;
  });
  await notifyPayment(actor.companyId, paymentId, actor.id);
  return claimDto(await findClaim(prisma, actor.companyId, id));
}

/** Refuses a receipt; the customer sees the reason on the invoice link. */
export async function rejectClaim(actor: Actor, id: string, reason: string) {
  const claim = await findClaim(prisma, actor.companyId, id);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.paymentClaim.updateMany({
      where: { id: claim.id, status: "pending" },
      data: { status: "rejected", rejectReason: reason, reviewedAt: new Date(), reviewedById: actor.id },
    });
    if (count === 0) throw alreadyReviewed();
    await tx.invoiceEvent.create({
      data: {
        invoiceId: claim.invoiceId,
        type: "paymentClaimRejected",
        values: { amount: moneyString(claim.amount), reason },
        userId: actor.id,
      },
    });
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "paymentClaimRejected",
      item: { type: "invoice", id: claim.invoice.id, ref: `${claim.invoice.numberPrefix}${claim.invoice.number}` },
      values: { amount: moneyString(claim.amount), reason, customer: claim.invoice.customerName },
    });
  });
  return claimDto(await findClaim(prisma, actor.companyId, id));
}

export async function getClaimReceipt(companyId: string, id: string) {
  const claim = await prisma.paymentClaim.findFirst({
    where: { id, companyId },
    select: { receipt: { select: { contentType: true, data: true, name: true } } },
  });
  if (!claim) throw notFound("Receipt");
  return claim.receipt;
}

// ---------------------------------------------------------------------------
// Proof on a payment staff recorded themselves
// ---------------------------------------------------------------------------

async function findPayment(companyId: string, id: string) {
  const payment = await prisma.invoicePayment.findFirst({
    where: { id, companyId },
    select: {
      id: true,
      number: true,
      proofFileId: true,
      invoice: { select: { id: true, number: true, numberPrefix: true } },
      proof: { select: { claimReceiptOf: { select: { id: true } } } },
    },
  });
  if (!payment) throw notFound("Payment");
  return payment;
}

/** Attaches (or replaces) the proof of a payment: a receipt or transfer screenshot. */
export async function attachPaymentProof(actor: Actor, id: string, body: unknown, name: string | null) {
  const { data, contentType } = checkUpload("receipt", body);
  const payment = await findPayment(actor.companyId, id);
  await prisma.$transaction(async (tx) => {
    const file = await tx.storedFile.create({
      data: { kind: "receipt", contentType, size: data.length, name, data: new Uint8Array(data), companyId: actor.companyId, createdById: actor.id },
      select: { id: true },
    });
    const { count } = await tx.invoicePayment.updateMany({
      where: { id: payment.id, companyId: actor.companyId, proofFileId: payment.proofFileId },
      data: { proofFileId: file.id },
    });
    if (count === 0) throw new AppError(409, "PAYMENT_CHANGED", "The payment changed meanwhile; reload and try again");
    // The old proof goes, unless it is a customer's receipt (that stays with their claim).
    if (payment.proofFileId && !payment.proof?.claimReceiptOf) {
      await tx.storedFile.deleteMany({ where: { id: payment.proofFileId, companyId: actor.companyId } });
    }
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "paymentProofAttached",
      item: { type: "invoice", id: payment.invoice.id, ref: `${payment.invoice.numberPrefix}${payment.invoice.number}` },
      values: { payment: paymentNumber(payment.number), name: name ?? undefined },
    });
  });
  return { proof: { contentType, size: data.length, name } };
}

export async function getPaymentProof(companyId: string, id: string) {
  const payment = await prisma.invoicePayment.findFirst({
    where: { id, companyId },
    select: { proof: { select: { contentType: true, data: true, name: true } } },
  });
  if (!payment?.proof) throw notFound("Proof");
  return payment.proof;
}
