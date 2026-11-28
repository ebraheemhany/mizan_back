// E-invoicing with the Egyptian Tax Authority (ETA): the company's setup, what's missing
// before a document can go, sending an invoice or a credit note, following what ETA said,
// and asking ETA to cancel.
//
// Signing: production needs every document signed with the company's eSeal (a USB token
// whose key never leaves it), which needs a local signer. Until that exists, documents go
// to ETA's preprod as version 0.9 (the same structure with signature checks off).
import { z } from "zod";
import type { EtaSetup, Prisma } from "../../generated/prisma/client.js";
import { businessToday, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { open, seal } from "../../lib/secret-box.js";
import { audit } from "../audit/audit.service.js";
import { creditNoteNumber, findRow, type InvoiceRef } from "../invoices/invoices.service.js";
import {
  etaCancel,
  etaDocumentDetails,
  etaPublicUrl,
  etaSubmissionStatus,
  etaSubmit,
  etaToken,
  type EtaCredentials,
  type EtaProblem,
} from "./eta.client.js";
import { ETA_ACTIVITY_CODES, ETA_UNIT_CODES } from "./eta.codes.js";
import { buildEtaDocument, etaIssuedAt, type EtaAddress, type EtaLineInput, type EtaParty } from "./eta.document.js";

type Actor = { id: string; companyId: string };

/** From this total (EGP, VAT included) a person buyer's national ID is required (ETA, from Aug 2024). */
export const PERSON_ID_THRESHOLD = new Decimal(process.env.ETA_PERSON_ID_THRESHOLD ?? 25_000);
/** How long to wait between looks at a fresh submission's status. */
const pollMs = () => Number(process.env.ETA_POLL_MS ?? 1500);

const digits = (s: string | null | undefined) => (s ?? "").replace(/[\s-]/g, "");

// ---------------------------------------------------------------------------
// Setup (owner, in Settings)
// ---------------------------------------------------------------------------

const text = (max: number) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() || null : v), z.string().max(max).nullable().optional());

export const etaSetupSchema = z.object({
  environment: z.enum(["preprod", "production"]).optional(),
  clientId: text(100),
  // Write-only: given = replace; left out = keep.
  clientSecret: z.string().trim().min(1).max(200).optional(),
  activityCode: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.string().refine((v) => ETA_ACTIVITY_CODES.has(v), "Not an ETA activity code").nullable().optional(),
  ),
  branchId: z.string().trim().regex(/^\d{1,10}$/).optional(),
  governorate: text(100),
  regionCity: text(100),
  street: text(200),
  buildingNumber: text(100),
  postalCode: text(30),
  floor: text(100),
  room: text(100),
  landmark: text(500),
  additionalInfo: text(500),
  defaultCodeType: z.preprocess((v) => (v === "" ? null : v), z.enum(["GS1", "EGS"]).nullable().optional()),
  defaultCode: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || null : v),
    z.string().max(100).regex(/^[A-Za-z0-9-]+$/).nullable().optional(),
  ),
  defaultUnit: z
    .string()
    .trim()
    .refine((v) => ETA_UNIT_CODES.has(v), "Not an ETA unit code")
    .optional(),
});
export type EtaSetupInput = z.infer<typeof etaSetupSchema>;

function setupDto(company: { name: string; taxNumber: string | null; currency: string }, setup: EtaSetup | null) {
  return {
    companyName: company.name,
    taxNumber: company.taxNumber,
    currency: company.currency,
    environment: setup?.environment ?? "preprod",
    clientId: setup?.clientId ?? null,
    hasSecret: Boolean(setup?.clientSecret),
    activityCode: setup?.activityCode ?? null,
    branchId: setup?.branchId ?? "0",
    governorate: setup?.governorate ?? null,
    regionCity: setup?.regionCity ?? null,
    street: setup?.street ?? null,
    buildingNumber: setup?.buildingNumber ?? null,
    postalCode: setup?.postalCode ?? null,
    floor: setup?.floor ?? null,
    room: setup?.room ?? null,
    landmark: setup?.landmark ?? null,
    additionalInfo: setup?.additionalInfo ?? null,
    defaultCodeType: setup?.defaultCodeType ?? null,
    defaultCode: setup?.defaultCode ?? null,
    defaultUnit: setup?.defaultUnit ?? "EA",
    verifiedAt: setup?.verifiedAt?.toISOString() ?? null,
    // Signing with the company's eSeal isn't available yet: production can't be used.
    signingAvailable: false,
  };
}

const companyWithSetup = (companyId: string) =>
  prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true, taxNumber: true, currency: true, etaSetup: true },
  });

export async function getSetup(companyId: string) {
  const company = await companyWithSetup(companyId);
  return setupDto(company, company.etaSetup);
}

export async function saveSetup(actor: Actor, input: EtaSetupInput) {
  const current = await prisma.etaSetup.findUnique({ where: { companyId: actor.companyId } });
  // The default code and its type go together (checked on what the setup will hold).
  const nextType = input.defaultCodeType !== undefined ? input.defaultCodeType : (current?.defaultCodeType ?? null);
  const nextCode = input.defaultCode !== undefined ? input.defaultCode : (current?.defaultCode ?? null);
  if (Boolean(nextType) !== Boolean(nextCode)) {
    throw new AppError(400, "VALIDATION_ERROR", "A default code needs its type", { field: nextType ? "defaultCode" : "defaultCodeType" });
  }
  const { clientSecret, branchId, environment, defaultUnit, ...rest } = input;
  const data: Prisma.EtaSetupUncheckedUpdateInput = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) (data as Record<string, unknown>)[key] = value;
  if (branchId !== undefined) data.branchId = branchId;
  if (environment !== undefined) data.environment = environment;
  if (defaultUnit !== undefined) data.defaultUnit = defaultUnit;
  if (clientSecret !== undefined) data.clientSecret = seal(clientSecret);
  // New credentials or another environment: they have to be checked again.
  const credentialsChanged =
    clientSecret !== undefined ||
    (input.clientId !== undefined && input.clientId !== (current?.clientId ?? null)) ||
    (environment !== undefined && environment !== current?.environment);
  if (credentialsChanged) data.verifiedAt = null;

  await prisma.$transaction(async (tx) => {
    await tx.etaSetup.upsert({
      where: { companyId: actor.companyId },
      create: { ...(data as Prisma.EtaSetupUncheckedCreateInput), companyId: actor.companyId },
      update: data,
    });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "etaSetupSaved",
      item: { type: "settings" },
      values: { credentials: credentialsChanged ? true : undefined },
    });
  });
  return getSetup(actor.companyId);
}

function credentialsOf(setup: EtaSetup | null): EtaCredentials | null {
  if (!setup?.clientId || !setup.clientSecret) return null;
  return { environment: setup.environment, clientId: setup.clientId, clientSecret: open(setup.clientSecret) };
}

/** Asks ETA for a token with the saved credentials: proves they work. */
export async function verifySetup(actor: Actor) {
  const company = await companyWithSetup(actor.companyId);
  const creds = credentialsOf(company.etaSetup);
  if (!creds) throw new AppError(400, "ETA_NO_CREDENTIALS", "Enter the client id and secret first");
  await etaToken(creds, { fresh: true });
  await prisma.etaSetup.update({ where: { companyId: actor.companyId }, data: { verifiedAt: new Date() } });
  return getSetup(actor.companyId);
}

export async function clearCredentials(actor: Actor) {
  await prisma.etaSetup.updateMany({
    where: { companyId: actor.companyId },
    data: { clientId: null, clientSecret: null, verifiedAt: null },
  });
  await audit(prisma, actor.companyId, { action: "update", event: "etaDisconnected", item: { type: "settings" } });
  return getSetup(actor.companyId);
}

// ---------------------------------------------------------------------------
// What's missing before a document can go
// ---------------------------------------------------------------------------

/** Something to fix first, and where (settings, the customer, a line's item). */
export type Readiness =
  | { code: "SETUP_CREDENTIALS" | "TAX_NUMBER" | "ACTIVITY_CODE" | "ISSUER_ADDRESS" | "CURRENCY" | "SIGNING" }
  | { code: "CUSTOMER_TAX_NUMBER" | "CUSTOMER_NATIONAL_ID" | "CUSTOMER_ADDRESS" | "CUSTOMER_FOREIGN"; customerId: string }
  | { code: "LINE_CODE"; line: number; description: string; productId: string | null }
  | { code: "INVOICE_NOT_AT_ETA" | "CREDIT_LINE_ITEM"; line?: number };

type CompanyCtx = Awaited<ReturnType<typeof companyWithSetup>>;

function issuerOf(company: CompanyCtx, problems: Readiness[]): EtaParty {
  const s = company.etaSetup;
  if (!credentialsOf(s)) problems.push({ code: "SETUP_CREDENTIALS" });
  if (!/^\d{9}$/.test(digits(company.taxNumber))) problems.push({ code: "TAX_NUMBER" });
  if (!s?.activityCode) problems.push({ code: "ACTIVITY_CODE" });
  if (!s?.governorate || !s.regionCity || !s.street || !s.buildingNumber) problems.push({ code: "ISSUER_ADDRESS" });
  if (company.currency !== "EGP") problems.push({ code: "CURRENCY" });
  if (s?.environment === "production") problems.push({ code: "SIGNING" });
  const address: EtaAddress = {
    branchID: s?.branchId ?? "0",
    country: "EG",
    governate: s?.governorate ?? "",
    regionCity: s?.regionCity ?? "",
    street: s?.street ?? "",
    buildingNumber: s?.buildingNumber ?? "",
    ...(s?.postalCode ? { postalCode: s.postalCode } : {}),
    ...(s?.floor ? { floor: s.floor } : {}),
    ...(s?.room ? { room: s.room } : {}),
    ...(s?.landmark ? { landmark: s.landmark } : {}),
    ...(s?.additionalInfo ? { additionalInformation: s.additionalInfo } : {}),
  };
  return { type: "B", id: digits(company.taxNumber), name: company.name, address };
}

type CustomerEta = {
  id: string;
  etaType: "B" | "P" | "F" | null;
  taxNumber: string | null;
  nationalId: string | null;
  country: string | null;
  governorate: string | null;
  city: string | null;
  street: string | null;
  buildingNumber: string | null;
};

const customerEtaSelect = {
  id: true,
  etaType: true,
  taxNumber: true,
  nationalId: true,
  country: true,
  governorate: true,
  city: true,
  street: true,
  buildingNumber: true,
} satisfies Prisma.CustomerSelect;

function receiverOf(c: CustomerEta, name: string, total: Prisma.Decimal, issuerId: string, problems: Readiness[]): EtaParty {
  const type = c.etaType ?? (digits(c.taxNumber) ? "B" : "P");
  const hasAddress = Boolean(c.governorate && c.city && c.street && c.buildingNumber);
  const address = (country: string): EtaAddress => ({
    country,
    governate: c.governorate ?? "",
    regionCity: c.city ?? "",
    street: c.street ?? "",
    buildingNumber: c.buildingNumber ?? "",
  });
  if (type === "B") {
    const id = digits(c.taxNumber);
    if (!/^\d{9}$/.test(id) || id === issuerId) problems.push({ code: "CUSTOMER_TAX_NUMBER", customerId: c.id });
    if (!hasAddress) problems.push({ code: "CUSTOMER_ADDRESS", customerId: c.id });
    return { type, id, name, address: address("EG") };
  }
  if (type === "F") {
    const country = (c.country ?? "").toUpperCase();
    if (!digits(c.taxNumber) || !/^[A-Z]{2}$/.test(country) || country === "EG") problems.push({ code: "CUSTOMER_FOREIGN", customerId: c.id });
    if (!hasAddress) problems.push({ code: "CUSTOMER_ADDRESS", customerId: c.id });
    return { type, id: (c.taxNumber ?? "").trim(), name, address: address(country || "EG") };
  }
  // A person: the national ID (and a full address) only from ETA's threshold up.
  const needsId = total.gte(PERSON_ID_THRESHOLD);
  if (needsId && !/^\d{14}$/.test(c.nationalId ?? "")) problems.push({ code: "CUSTOMER_NATIONAL_ID", customerId: c.id });
  if (needsId && !hasAddress) problems.push({ code: "CUSTOMER_ADDRESS", customerId: c.id });
  return { type, ...(c.nationalId ? { id: c.nationalId } : {}), name, address: address("EG") };
}

// ---------------------------------------------------------------------------
// Submissions as the API shows them
// ---------------------------------------------------------------------------

const submissionSelect = {
  id: true,
  environment: true,
  status: true,
  uuid: true,
  longId: true,
  internalId: true,
  errors: true,
  submittedAt: true,
  checkedAt: true,
  cancelRequestedAt: true,
  total: true,
  submissionId: true,
} satisfies Prisma.EtaSubmissionSelect;
type SubmissionRow = Prisma.EtaSubmissionGetPayload<{ select: typeof submissionSelect }>;

function submissionDto(row: SubmissionRow) {
  return {
    id: row.id,
    environment: row.environment,
    status: row.status,
    uuid: row.uuid,
    internalId: row.internalId,
    errors: (row.errors as EtaProblem[] | null) ?? [],
    submittedAt: row.submittedAt.toISOString(),
    checkedAt: row.checkedAt?.toISOString() ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    total: row.total?.toString() ?? null,
    publicUrl: row.uuid && row.longId ? etaPublicUrl(row.environment, row.uuid, row.longId) : null,
  };
}

const latest = (where: { invoiceId: string } | { creditNoteId: string }) =>
  prisma.etaSubmission.findFirst({ where, orderBy: { submittedAt: "desc" }, select: submissionSelect });

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

const invoiceSelect = {
  id: true,
  number: true,
  numberPrefix: true,
  status: true,
  issueDate: true,
  sentAt: true,
  vatRate: true,
  total: true,
  customerName: true,
  customer: { select: customerEtaSelect },
  lines: {
    orderBy: { position: "asc" },
    select: {
      description: true,
      quantity: true,
      unitPrice: true,
      productId: true,
      product: { select: { code: true, etaCodeType: true, etaCode: true, etaUnit: true } },
    },
  },
  creditNotes: {
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      date: true,
      createdAt: true,
      vatRate: true,
      total: true,
      lines: {
        orderBy: { position: "asc" },
        select: { description: true, quantity: true, unitPrice: true, productId: true, product: { select: { code: true } } },
      },
    },
  },
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceSelect }>;

const issued = (status: string) => status === "sent" || status === "partial" || status === "paid";

/** The lines as ETA items: the linked product's code, else the company's default code. */
function linesOf(invoice: InvoiceRow, setup: EtaSetup | null, problems: Readiness[]): EtaLineInput[] {
  return invoice.lines.map((line, i) => {
    const p = line.product;
    const own = p?.etaCode && p.etaCodeType ? { itemType: p.etaCodeType, itemCode: p.etaCode, unitType: p.etaUnit ?? setup?.defaultUnit ?? "EA" } : null;
    const fallback =
      setup?.defaultCode && setup.defaultCodeType
        ? { itemType: setup.defaultCodeType, itemCode: setup.defaultCode, unitType: p?.etaUnit ?? setup.defaultUnit }
        : null;
    const code = own ?? fallback;
    if (!code) problems.push({ code: "LINE_CODE", line: i + 1, description: line.description, productId: line.productId });
    return {
      description: line.description,
      itemType: code?.itemType ?? "EGS",
      itemCode: code?.itemCode ?? "",
      unitType: code?.unitType ?? "EA",
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(p?.code ? { internalCode: p.code } : {}),
    };
  });
}

function prepareInvoice(company: CompanyCtx, invoice: InvoiceRow) {
  const problems: Readiness[] = [];
  const issuer = issuerOf(company, problems);
  const receiver = receiverOf(invoice.customer, invoice.customerName, invoice.total, issuer.id ?? "", problems);
  const lines = linesOf(invoice, company.etaSetup, problems);
  const input = {
    documentType: "I" as const,
    version: "0.9" as const,
    issuer,
    receiver,
    dateTimeIssued: etaIssuedAt(toIso(invoice.issueDate), invoice.sentAt, businessToday()),
    activityCode: company.etaSetup?.activityCode ?? "",
    internalId: `${invoice.numberPrefix}${invoice.number}`,
    lines,
    vatRate: invoice.vatRate,
  };
  return { input, problems };
}

/** The invoice and its credit notes at ETA, and what's missing for the ones not sent yet. */
export async function invoiceEta(companyId: string, ref: InvoiceRef) {
  const [company, invoice] = await Promise.all([companyWithSetup(companyId), findRow(prisma, companyId, ref, invoiceSelect)]);
  const configured = Boolean(credentialsOf(company.etaSetup));
  const current = await latest({ invoiceId: invoice.id });
  const { problems } = prepareInvoice(company, invoice);
  const notes = await Promise.all(
    invoice.creditNotes.map(async (note) => {
      const sub = await latest({ creditNoteId: note.id });
      const prep = await prepareCreditNote(company, invoice, note.id).catch(() => null);
      return { id: note.id, number: creditNoteNumber(note.number), eta: sub ? submissionDto(sub) : null, problems: prep?.problems ?? [] };
    }),
  );
  return {
    configured,
    environment: company.etaSetup?.environment ?? "preprod",
    eta: current ? submissionDto(current) : null,
    problems: issued(invoice.status) ? problems : [],
    creditNotes: notes,
  };
}

/** One send at a time per document (a double click mustn't register it twice at ETA). */
const inFlight = new Map<string, Promise<unknown>>();
async function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new AppError(409, "ETA_BUSY_SENDING", "It is being sent already");
  const run = fn();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

const notReady = (problems: Readiness[]) =>
  new AppError(400, "ETA_NOT_READY", "Some details are missing before it can go to the tax authority", { problems });

/** Sends an issued invoice to ETA, and waits a little for ETA's checks. */
export async function submitInvoice(actor: Actor, ref: InvoiceRef) {
  const company = await companyWithSetup(actor.companyId);
  const invoice = await findRow(prisma, actor.companyId, ref, invoiceSelect);
  return once(`invoice:${invoice.id}`, async () => {
    if (!issued(invoice.status)) throw new AppError(409, "ETA_INVOICE_NOT_ISSUED", "Only an issued invoice goes to the tax authority");
    const before = await latest({ invoiceId: invoice.id });
    if (before && (before.status === "submitted" || before.status === "valid")) {
      throw new AppError(409, "ETA_ALREADY_SUBMITTED", "It is at the tax authority already");
    }
    const { input, problems } = prepareInvoice(company, invoice);
    if (problems.length) throw notReady(problems);
    const row = await send(actor, credentialsOf(company.etaSetup)!, input, { invoiceId: invoice.id }, "etaInvoiceSent");
    return submissionDto(row);
  });
}

async function send(
  actor: Actor,
  creds: EtaCredentials,
  input: Parameters<typeof buildEtaDocument>[0],
  owner: { invoiceId: string } | { creditNoteId: string },
  event: string,
) {
  const { document, totalAmount } = buildEtaDocument(input);
  const json = JSON.stringify(document);
  const result = await etaSubmit(creds, json);
  let row = await prisma.etaSubmission.create({
    data: {
      environment: creds.environment,
      status: result.accepted ? "submitted" : "rejected",
      uuid: result.accepted ? result.uuid : null,
      longId: result.accepted ? result.longId : null,
      submissionId: result.submissionId,
      internalId: input.internalId,
      ...(result.accepted ? {} : { errors: result.problems as unknown as Prisma.InputJsonValue }),
      document: document as Prisma.InputJsonValue,
      total: totalAmount,
      createdById: actor.id,
      companyId: actor.companyId,
      ...owner,
    },
    select: submissionSelect,
  });
  await audit(prisma, actor.companyId, {
    action: "send",
    event,
    item: "invoiceId" in owner ? { type: "invoice", id: owner.invoiceId, ref: input.internalId } : { type: "invoice", ref: input.internalId },
    values: { number: input.internalId, status: row.status },
  });
  // ETA checks it in the background: a few looks, then the user can refresh.
  if (result.accepted) row = await settle(creds, row);
  return row;
}

async function settle(creds: EtaCredentials, row: SubmissionRow) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, pollMs()));
    const status = await etaSubmissionStatus(creds, row.submissionId!, row.uuid!).catch(() => null);
    if (status && status !== "submitted") return record(creds, row, status);
  }
  return row;
}

/** Saves what ETA says now (with its reasons when the document failed its checks). */
async function record(creds: EtaCredentials, row: SubmissionRow, status: SubmissionRow["status"]) {
  let errors: EtaProblem[] | undefined;
  if (status === "invalid") errors = (await etaDocumentDetails(creds, row.uuid!).catch(() => null))?.problems;
  return prisma.etaSubmission.update({
    where: { id: row.id },
    data: { status, checkedAt: new Date(), ...(errors ? { errors: errors as unknown as Prisma.InputJsonValue } : {}) },
    select: submissionSelect,
  });
}

/** Asks ETA again about the latest submission (being checked, or a cancellation asked for). */
async function refresh(companyId: string, where: { invoiceId: string } | { creditNoteId: string }) {
  const row = await latest(where);
  if (!row?.uuid) throw new AppError(409, "ETA_NOT_SUBMITTED", "It hasn't been sent to the tax authority");
  if (row.status !== "submitted" && !(row.status === "valid" && row.cancelRequestedAt)) return submissionDto(row);
  const company = await companyWithSetup(companyId);
  const creds = credentialsOf(company.etaSetup);
  if (!creds || creds.environment !== row.environment) throw new AppError(409, "ETA_NO_CREDENTIALS", "The tax authority link isn't set up");
  const details = await etaDocumentDetails(creds, row.uuid);
  if (!details?.status) return submissionDto(row);
  const updated = await prisma.etaSubmission.update({
    where: { id: row.id },
    data: {
      status: details.status,
      checkedAt: new Date(),
      ...(details.status === "invalid" ? { errors: details.problems as unknown as Prisma.InputJsonValue } : {}),
    },
    select: submissionSelect,
  });
  return submissionDto(updated);
}

export async function refreshInvoice(actor: Actor, ref: InvoiceRef) {
  const invoice = await findRow(prisma, actor.companyId, ref, { id: true });
  return refresh(actor.companyId, { invoiceId: invoice.id });
}

export const cancelSchema = z.object({ reason: z.enum(["buyer", "details"]) });
const REASONS = { buyer: "Wrong buyer details", details: "Wrong invoice details" } as const;

async function cancel(actor: Actor, where: { invoiceId: string } | { creditNoteId: string }, reason: keyof typeof REASONS) {
  const row = await latest(where);
  if (!row?.uuid || row.status !== "valid") throw new AppError(409, "ETA_NOT_VALID", "Only a document valid at the tax authority can be cancelled there");
  const company = await companyWithSetup(actor.companyId);
  const creds = credentialsOf(company.etaSetup);
  if (!creds || creds.environment !== row.environment) throw new AppError(409, "ETA_NO_CREDENTIALS", "The tax authority link isn't set up");
  await etaCancel(creds, row.uuid, REASONS[reason]);
  await prisma.etaSubmission.update({ where: { id: row.id }, data: { cancelRequestedAt: new Date() } });
  await audit(prisma, actor.companyId, {
    action: "cancel",
    event: "etaCancelRequested",
    item: { type: "invoice", ref: row.internalId },
    values: { number: row.internalId, reason },
  });
  // ETA usually applies it at once (the buyer can still decline): look again.
  return refresh(actor.companyId, where);
}

export async function cancelInvoiceAtEta(actor: Actor, ref: InvoiceRef, reason: keyof typeof REASONS) {
  const invoice = await findRow(prisma, actor.companyId, ref, { id: true });
  return cancel(actor, { invoiceId: invoice.id }, reason);
}

// ---------------------------------------------------------------------------
// Credit notes: on an invoice that is valid at ETA, with its same items
// ---------------------------------------------------------------------------

async function prepareCreditNote(company: CompanyCtx, invoice: InvoiceRow, creditNoteId: string) {
  const note = invoice.creditNotes.find((n) => n.id === creditNoteId);
  if (!note) throw notFound("Credit note");
  const problems: Readiness[] = [];
  const issuerProblems: Readiness[] = [];
  issuerOf(company, issuerProblems);
  problems.push(...issuerProblems.filter((p) => p.code === "SETUP_CREDENTIALS" || p.code === "SIGNING"));

  // The invoice as ETA has it: the note keeps its issuer, receiver, activity and items.
  const sent = await prisma.etaSubmission.findFirst({
    where: { invoiceId: invoice.id, status: "valid" },
    orderBy: { submittedAt: "desc" },
    select: { uuid: true, document: true },
  });
  if (!sent?.uuid) problems.push({ code: "INVOICE_NOT_AT_ETA" });
  const doc = (sent?.document ?? {}) as {
    issuer?: EtaParty;
    receiver?: EtaParty;
    taxpayerActivityCode?: string;
    invoiceLines?: { itemType: "GS1" | "EGS"; itemCode: string; unitType: string; internalCode?: string }[];
  };
  const items = doc.invoiceLines ?? [];
  const distinct = [...new Map(items.map((l) => [`${l.itemType}:${l.itemCode}`, l])).values()];
  const lines: EtaLineInput[] = note.lines.map((line, i) => {
    // The same item as on the invoice: by the product's code, or the invoice's only item.
    const byProduct = line.product?.code ? items.find((l) => l.internalCode === line.product!.code) : undefined;
    const item = byProduct ?? (distinct.length === 1 ? distinct[0] : undefined);
    if (sent?.uuid && !item) problems.push({ code: "CREDIT_LINE_ITEM", line: i + 1 });
    return {
      description: line.description,
      itemType: item?.itemType ?? "EGS",
      itemCode: item?.itemCode ?? "",
      unitType: item?.unitType ?? "EA",
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(item?.internalCode ? { internalCode: item.internalCode } : {}),
    };
  });
  const input = {
    documentType: "C" as const,
    version: "0.9" as const,
    issuer: doc.issuer ?? { type: "B" as const, name: company.name },
    receiver: doc.receiver ?? { type: "P" as const, name: invoice.customerName },
    dateTimeIssued: etaIssuedAt(toIso(note.date), note.createdAt, businessToday()),
    activityCode: doc.taxpayerActivityCode ?? "",
    internalId: creditNoteNumber(note.number),
    references: sent?.uuid ? [sent.uuid] : [],
    lines,
    vatRate: note.vatRate,
  };
  return { input, problems };
}

export async function submitCreditNote(actor: Actor, ref: InvoiceRef, creditNoteId: string) {
  const company = await companyWithSetup(actor.companyId);
  const invoice = await findRow(prisma, actor.companyId, ref, invoiceSelect);
  return once(`credit:${creditNoteId}`, async () => {
    const before = await latest({ creditNoteId });
    if (before && (before.status === "submitted" || before.status === "valid")) {
      throw new AppError(409, "ETA_ALREADY_SUBMITTED", "It is at the tax authority already");
    }
    const { input, problems } = await prepareCreditNote(company, invoice, creditNoteId);
    if (problems.length) throw notReady(problems);
    const row = await send(actor, credentialsOf(company.etaSetup)!, input, { creditNoteId }, "etaCreditNoteSent");
    return submissionDto(row);
  });
}

async function creditNoteOf(companyId: string, ref: InvoiceRef, creditNoteId: string) {
  const invoice = await findRow(prisma, companyId, ref, { id: true });
  const note = await prisma.creditNote.findFirst({ where: { id: creditNoteId, invoiceId: invoice.id, companyId }, select: { id: true } });
  if (!note) throw notFound("Credit note");
  return note.id;
}

export async function refreshCreditNote(actor: Actor, ref: InvoiceRef, creditNoteId: string) {
  return refresh(actor.companyId, { creditNoteId: await creditNoteOf(actor.companyId, ref, creditNoteId) });
}

export async function cancelCreditNoteAtEta(actor: Actor, ref: InvoiceRef, creditNoteId: string, reason: keyof typeof REASONS) {
  return cancel(actor, { creditNoteId: await creditNoteOf(actor.companyId, ref, creditNoteId) }, reason);
}
