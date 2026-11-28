// Files attached to an invoice: the customer's purchase order, a delivery note, a signed
// copy... Images or PDFs, kept with the invoice (drafts and cancelled ones included).
// They don't touch the books, so a closed month doesn't stop them.
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { checkUpload } from "../files/files.service.js";
import { findRow, type InvoiceRef } from "./invoices.service.js";

type Actor = { id: string; companyId: string };

/** No more than this many files on one invoice. */
export const MAX_ATTACHMENTS = 20;

const invoiceRef = (invoice: { id: string; number: number | null; numberPrefix: string | null }) => ({
  type: "invoice" as const,
  id: invoice.id,
  ref: invoice.number !== null ? `${invoice.numberPrefix ?? ""}${invoice.number}` : null,
});

const attachmentSelect = {
  id: true,
  createdAt: true,
  file: { select: { name: true, contentType: true, size: true } },
  invoiceId: true,
} as const;

type Row = { id: string; createdAt: Date; file: { name: string | null; contentType: string; size: number } };

const toDto = (row: Row) => ({
  id: row.id,
  name: row.file.name,
  contentType: row.file.contentType,
  size: row.file.size,
  createdAt: row.createdAt.toISOString(),
});

export async function listAttachments(companyId: string, ref: InvoiceRef) {
  const invoice = await findRow(prisma, companyId, ref, { id: true });
  const rows = await prisma.invoiceAttachment.findMany({
    where: { invoiceId: invoice.id, companyId },
    orderBy: { createdAt: "asc" },
    select: attachmentSelect,
  });
  return rows.map(toDto);
}

export async function addAttachment(actor: Actor, ref: InvoiceRef, body: unknown, name: string | null) {
  const { data, contentType } = checkUpload("attachment", body);
  return prisma.$transaction(async (tx) => {
    const invoice = await findRow(tx, actor.companyId, ref, { id: true, number: true, numberPrefix: true });
    // Counted under the invoice row's lock, so two uploads at once can't pass the limit.
    await tx.$executeRaw`SELECT 1 FROM invoices WHERE id = ${invoice.id} FOR UPDATE`;
    if ((await tx.invoiceAttachment.count({ where: { invoiceId: invoice.id } })) >= MAX_ATTACHMENTS) {
      throw new AppError(409, "TOO_MANY_ATTACHMENTS", `An invoice can have at most ${MAX_ATTACHMENTS} files`, { max: MAX_ATTACHMENTS });
    }
    const file = await tx.storedFile.create({
      data: {
        kind: "attachment",
        contentType,
        size: data.length,
        name,
        data: new Uint8Array(data),
        companyId: actor.companyId,
        createdById: actor.id,
      },
      select: { id: true },
    });
    const row = await tx.invoiceAttachment.create({
      data: { fileId: file.id, invoiceId: invoice.id, companyId: actor.companyId },
      select: attachmentSelect,
    });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "invoiceAttachmentAdded",
      item: invoiceRef(invoice),
      values: { name: name ?? undefined, size: data.length },
    });
    return toDto(row);
  });
}

export async function getAttachment(companyId: string, ref: InvoiceRef, attachmentId: string) {
  const invoice = await findRow(prisma, companyId, ref, { id: true });
  const row = await prisma.invoiceAttachment.findFirst({
    where: { id: attachmentId, invoiceId: invoice.id, companyId },
    select: { file: { select: { contentType: true, data: true, name: true } } },
  });
  if (!row) throw notFound("Attachment");
  return row.file;
}

export async function removeAttachment(actor: Actor, ref: InvoiceRef, attachmentId: string) {
  await prisma.$transaction(async (tx) => {
    const invoice = await findRow(tx, actor.companyId, ref, { id: true, number: true, numberPrefix: true });
    const row = await tx.invoiceAttachment.findFirst({
      where: { id: attachmentId, invoiceId: invoice.id, companyId: actor.companyId },
      select: { fileId: true, file: { select: { name: true } } },
    });
    if (!row) throw notFound("Attachment");
    // The attachment goes with its file.
    await tx.storedFile.deleteMany({ where: { id: row.fileId, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "invoiceAttachmentRemoved",
      item: invoiceRef(invoice),
      values: { name: row.file.name ?? undefined },
    });
  });
}
