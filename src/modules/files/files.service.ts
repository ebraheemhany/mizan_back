import type { FileKind } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";

type Actor = { id: string; companyId: string };

/** The most each kind may weigh, and the types it may be. */
export const FILE_RULES: Record<FileKind, { maxBytes: number; types: readonly string[] }> = {
  logo: { maxBytes: 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp"] },
  receipt: { maxBytes: 5 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp", "application/pdf"] },
  document: { maxBytes: 5 * 1024 * 1024, types: ["image/png", "image/jpeg", "image/webp", "application/pdf"] },
};

/**
 * What the file really is, from its first bytes (the browser's word for it is
 * not trusted: a renamed file, or an HTML page calling itself an image, is refused).
 * SVG is not accepted at all: it can carry scripts.
 */
export function sniffType(data: Buffer): string | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (data.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** Checks an uploaded body: present, not too big, and of a type this kind allows. */
export function checkUpload(kind: FileKind, body: unknown) {
  const data = Buffer.isBuffer(body) ? body : null;
  if (!data || data.length === 0) throw new AppError(400, "FILE_EMPTY", "Send the file as the request body");
  const rules = FILE_RULES[kind];
  if (data.length > rules.maxBytes) {
    throw new AppError(413, "FILE_TOO_LARGE", `The file can be at most ${rules.maxBytes / 1024 / 1024} MB`, {
      maxBytes: rules.maxBytes,
    });
  }
  const contentType = sniffType(data);
  if (!contentType || !rules.types.includes(contentType)) {
    throw new AppError(415, "FILE_TYPE", "This kind of file isn't accepted here", { types: rules.types });
  }
  return { data, contentType };
}

/** A file name from the X-File-Name header (URI-encoded so it can carry Arabic), kept short. */
export function fileName(header: unknown) {
  if (typeof header !== "string" || !header) return null;
  try {
    return decodeURIComponent(header).replace(/[\r\n"\\/]/g, "").slice(0, 120) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The company logo
// ---------------------------------------------------------------------------

/** Replaces the logo (the old file goes). */
export async function setLogo(actor: Actor, body: unknown, name: string | null) {
  const { data, contentType } = checkUpload("logo", body);
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { logoFileId: true } });
    const file = await tx.storedFile.create({
      data: { kind: "logo", contentType, size: data.length, name, data: new Uint8Array(data), companyId: actor.companyId, createdById: actor.id },
      select: { id: true },
    });
    await tx.company.update({ where: { id: actor.companyId }, data: { logoFileId: file.id } });
    if (company.logoFileId) await tx.storedFile.deleteMany({ where: { id: company.logoFileId, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "settings",
      event: "logoChanged",
      item: { type: "company", id: actor.companyId },
      values: { size: data.length },
    });
    return { logoId: file.id };
  });
}

export async function removeLogo(actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { logoFileId: true } });
    if (!company.logoFileId) return;
    await tx.company.update({ where: { id: actor.companyId }, data: { logoFileId: null } });
    await tx.storedFile.deleteMany({ where: { id: company.logoFileId, companyId: actor.companyId } });
    await audit(tx, actor.companyId, { action: "settings", event: "logoRemoved", item: { type: "company", id: actor.companyId } });
  });
}

/**
 * A logo by its id, for anyone (it is printed on the invoices customers open from
 * their link). Only logos: other files are never served this way.
 */
export async function getLogo(id: string) {
  const file = await prisma.storedFile.findFirst({
    where: { id, kind: "logo", logoOf: { isNot: null } },
    select: { contentType: true, data: true },
  });
  if (!file) throw notFound("Logo");
  return file;
}

// ---------------------------------------------------------------------------
// Expense receipts
// ---------------------------------------------------------------------------

async function findExpense(companyId: string, expenseId: string) {
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, companyId },
    select: { id: true, title: true, receiptFileId: true },
  });
  if (!expense) throw notFound("Expense");
  return expense;
}

/** Attaches (or replaces) an expense's receipt. It doesn't touch the books, so a closed month is fine. */
export async function attachReceipt(actor: Actor, expenseId: string, body: unknown, name: string | null) {
  const { data, contentType } = checkUpload("receipt", body);
  const expense = await findExpense(actor.companyId, expenseId);
  return prisma.$transaction(async (tx) => {
    const file = await tx.storedFile.create({
      data: { kind: "receipt", contentType, size: data.length, name, data: new Uint8Array(data), companyId: actor.companyId, createdById: actor.id },
      select: { id: true },
    });
    // Only if the expense still has the receipt that was read (two uploads at once: one wins).
    const { count } = await tx.expense.updateMany({
      where: { id: expense.id, companyId: actor.companyId, receiptFileId: expense.receiptFileId },
      data: { receiptFileId: file.id },
    });
    if (count === 0) {
      throw new AppError(409, "EXPENSE_CHANGED", "The expense changed meanwhile; reload and try again");
    }
    if (expense.receiptFileId) {
      await tx.storedFile.deleteMany({ where: { id: expense.receiptFileId, companyId: actor.companyId } });
    }
    await audit(tx, actor.companyId, {
      action: "update",
      event: "receiptAttached",
      item: { type: "expense", id: expense.id, ref: expense.title },
      values: { name: name ?? undefined, size: data.length },
    });
    return { receipt: { contentType, size: data.length, name } };
  });
}

export async function removeReceipt(actor: Actor, expenseId: string) {
  const expense = await findExpense(actor.companyId, expenseId);
  if (!expense.receiptFileId) return;
  await prisma.$transaction(async (tx) => {
    await tx.expense.updateMany({
      where: { id: expense.id, companyId: actor.companyId, receiptFileId: expense.receiptFileId },
      data: { receiptFileId: null },
    });
    await tx.storedFile.deleteMany({ where: { id: expense.receiptFileId!, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "receiptRemoved",
      item: { type: "expense", id: expense.id, ref: expense.title },
    });
  });
}

export async function getReceipt(companyId: string, expenseId: string) {
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, companyId },
    select: { receipt: { select: { contentType: true, data: true, name: true } } },
  });
  if (!expense?.receipt) throw notFound("Receipt");
  return expense.receipt;
}
