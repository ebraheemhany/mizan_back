// Credit notes: part (or all) of an issued invoice taken back — goods returned, a discount
// given after the fact, a correction. The note lowers what the customer owes; if they had
// already paid more than is now owed, the difference is refunded from the account named.
//
// On the invoice: credited += note's total, amountPaid -= refund, and the status follows
// what's settled (paid + credited): all of it "paid", some "partial", none "sent".
// In the books (ledger.sql): Dr sales, Dr VAT / Cr customers on the note's date, and
// for a refund Dr customers / Cr the account it came from.
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";

import { businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, invoiceTotals, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { checkBooksOpen } from "../ledger/ledger.periods.js";
import { moveStock, quantityString, reverseMovements } from "../products/stock.js";
import { creditNoteNumber, findRow, getInvoice, moveCustomerBalance, type InvoiceRef } from "./invoices.service.js";
import { isoDate, lineSchema, optionalText } from "./invoices.schemas.js";

type Actor = { id: string; companyId: string };
type Tx = Prisma.TransactionClient;

export const creditNoteSchema = z.object({
  date: isoDate,
  reason: z.enum(["return", "discount", "correction", "other"]),
  note: optionalText(300),
  // On a return, productId names the invoice's item that came back (it goes back into stock).
  lines: z.array(lineSchema).min(1).max(100),
  /** Where a refund comes from, when the customer had paid more than is now owed. */
  refundAccount: z.enum(["bank", "cashbox", "wallet"]).optional(),
});
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

/** The invoice's status from what is settled of it (paid + credited), as SQL on the updated row. */
const STATUS_FROM_SETTLED = `(CASE WHEN "amountPaid" + "credited" >= "total" THEN 'paid'
  WHEN "amountPaid" + "credited" > 0 THEN 'partial' ELSE 'sent' END)::"InvoiceStatus"`;

export async function createCreditNote(actor: Actor, ref: InvoiceRef, input: CreditNoteInput) {
  const today = businessToday();
  if (input.date > today) {
    throw new AppError(400, "CREDIT_NOTE_DATE_IN_FUTURE", "The credit note's date can't be in the future", { field: "date" });
  }
  await prisma.$transaction(async (tx) => {
    // The number is taken by updating the company row: it stays locked until this ends, so
    // payments and other credit notes on the company wait (what's owed can't move meanwhile).
    const company = await tx.company.update({
      where: { id: actor.companyId },
      data: { creditNoteNextNumber: { increment: 1 } },
      select: { creditNoteNextNumber: true, booksClosedThrough: true },
    });
    const invoice = await findRow(tx, actor.companyId, ref, {
      id: true,
      status: true,
      number: true,
      numberPrefix: true,
      customerId: true,
      customerName: true,
      issueDate: true,
      vatRate: true,
      total: true,
      amountPaid: true,
      credited: true,
    });
    if (!["sent", "partial", "paid"].includes(invoice.status)) {
      throw new AppError(409, "INVOICE_NOT_CREDITABLE", "Only an issued invoice (not a draft or cancelled one) can have a credit note");
    }
    if (input.date < toIso(invoice.issueDate)) {
      throw new AppError(400, "CREDIT_NOTE_BEFORE_INVOICE", "The credit note can't be dated before the invoice", { field: "date" });
    }
    checkBooksOpen(company.booksClosedThrough, [input.date]);
    const returning = input.reason === "return";
    if (returning) await checkReturnable(tx, invoice.id, input.lines);

    const { amounts, subtotal, vat, total } = invoiceTotals(input.lines, invoice.vatRate);
    if (total.lte(0)) throw new AppError(400, "VALIDATION_ERROR", "The credit note has no amount", { field: "lines" });
    // Never more than what's left of the invoice to take back.
    const creditable = invoice.total.minus(invoice.credited);
    if (total.gt(creditable)) {
      throw new AppError(409, "CREDIT_EXCEEDS_INVOICE", "The credit note is more than what's left of the invoice", {
        creditable: moneyString(creditable),
      });
    }
    // What the customer still owes; past that, they paid it already: refunded.
    const unpaid = Decimal.max(ZERO, invoice.total.minus(invoice.amountPaid).minus(invoice.credited));
    const refund = Decimal.max(ZERO, total.minus(unpaid));
    if (refund.gt(0) && !input.refundAccount) {
      throw new AppError(400, "REFUND_ACCOUNT_REQUIRED", "Say where the refund to the customer comes from", {
        field: "refundAccount",
        refund: moneyString(refund),
      });
    }

    const number = company.creditNoteNextNumber - 1;
    const note = await tx.creditNote.create({
      data: {
        number,
        date: toDate(input.date),
        reason: input.reason,
        note: input.note ?? null,
        subtotal,
        vatRate: invoice.vatRate,
        vat,
        total,
        refund,
        refundAccount: refund.gt(0) ? (input.refundAccount ?? null) : null,
        createdById: actor.id,
        companyId: actor.companyId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        lines: {
          create: input.lines.map((line, position) => ({
            position,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: amounts[position]!,
            // Only a return is about the catalog item itself.
            productId: returning ? (line.productId ?? null) : null,
          })),
        },
      },
      select: { id: true },
    });
    // What came back goes back into stock, on the note's date.
    if (returning) {
      await moveStock(tx, actor.companyId, input.lines, 1, {
        kind: "returned",
        date: input.date,
        userId: actor.id,
        creditNoteId: note.id,
      });
    }
    // Checked again in the update itself: nothing credited or refunded beyond the invoice.
    const updated = await tx.$executeRawUnsafe(
      `UPDATE "invoices"
       SET "credited" = "credited" + $1::numeric, "amountPaid" = "amountPaid" - $2::numeric, "updatedAt" = now()
       WHERE "id" = $3 AND "credited" + $1::numeric <= "total" AND "amountPaid" - $2::numeric >= 0`,
      total.toFixed(2),
      refund.toFixed(2),
      invoice.id,
    );
    if (updated === 0) throw new AppError(409, "CREDIT_EXCEEDS_INVOICE", "The credit note is more than what's left of the invoice");
    await tx.$executeRawUnsafe(`UPDATE "invoices" SET "status" = ${STATUS_FROM_SETTLED} WHERE "id" = $1`, invoice.id);

    // The customer owes less by what wasn't refunded.
    await moveCustomerBalance(tx, invoice.customerId, total.minus(refund).negated());
    const invoiceText = `${invoice.numberPrefix}${invoice.number}`;
    await tx.invoiceEvent.create({
      data: {
        invoiceId: invoice.id,
        type: "creditNote",
        values: { number: creditNoteNumber(number), total: moneyString(total), ...(refund.gt(0) ? { refund: moneyString(refund) } : {}) },
        userId: actor.id,
      },
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: "creditNoteIssued",
      item: { type: "invoice", id: invoice.id, ref: invoiceText },
      values: {
        number: creditNoteNumber(number),
        amount: moneyString(total),
        reason: input.reason,
        customer: invoice.customerName,
        ...(refund.gt(0) ? { refund: moneyString(refund) } : {}),
      },
    });
    return note.id;
  });
  return getInvoice(actor.companyId, ref);
}

/**
 * A return names the invoice's own items, and never more of one than the invoice sold, less
 * what earlier returns on it already took back.
 */
async function checkReturnable(tx: Tx, invoiceId: string, lines: CreditNoteInput["lines"]) {
  const wanted = new Map<string, Decimal>();
  for (const line of lines) {
    if (!line.productId) continue;
    wanted.set(line.productId, (wanted.get(line.productId) ?? ZERO).plus(new Decimal(line.quantity)));
  }
  if (wanted.size === 0) return;
  const [sold, returned] = await Promise.all([
    tx.invoiceLine.findMany({ where: { invoiceId, productId: { in: [...wanted.keys()] } }, select: { productId: true, quantity: true } }),
    tx.creditNoteLine.findMany({
      where: { creditNote: { invoiceId, reason: "return" }, productId: { in: [...wanted.keys()] } },
      select: { productId: true, quantity: true },
    }),
  ]);
  const sum = (rows: { productId: string | null; quantity: Decimal }[], id: string) =>
    rows.filter((r) => r.productId === id).reduce((total, r) => total.plus(r.quantity), ZERO);
  for (const [productId, quantity] of wanted) {
    const onInvoice = sum(sold, productId);
    if (onInvoice.isZero()) {
      throw new AppError(400, "INVALID_PRODUCT", "A returned item isn't on this invoice", { field: "lines" });
    }
    const returnable = onInvoice.minus(sum(returned, productId));
    if (quantity.gt(returnable)) {
      throw new AppError(409, "RETURN_EXCEEDS_SOLD", "More is returned than the invoice sold", {
        productId,
        returnable: quantityString(Decimal.max(ZERO, returnable)),
      });
    }
  }
}

/** Undoes a credit note (a mistake): the invoice owes again what it took off, and a refund is taken back. */
export async function deleteCreditNote(actor: Actor, ref: InvoiceRef, id: string) {
  await prisma.$transaction(async (tx) => {
    const company = await tx.company.update({
      where: { id: actor.companyId },
      data: { creditNoteNextNumber: { increment: 0 } },
      select: { booksClosedThrough: true },
    });
    const invoice = await findRow(tx, actor.companyId, ref, { id: true, number: true, numberPrefix: true, customerName: true });
    const note = await tx.creditNote.findFirst({
      where: { id, invoiceId: invoice.id, companyId: actor.companyId },
      select: { id: true, number: true, date: true, total: true, refund: true, customerId: true },
    });
    if (!note) throw notFound("Credit note");
    checkBooksOpen(company.booksClosedThrough, [toIso(note.date)]);

    // Its returns leave the stock again (before the note goes, while the movements name it).
    await reverseMovements(tx, actor.companyId, { creditNoteId: note.id, kind: "returned" }, {
      kind: "returnRemoved",
      date: businessToday(),
      userId: actor.id,
    });
    await tx.creditNote.delete({ where: { id: note.id } });
    await tx.$executeRawUnsafe(
      `UPDATE "invoices"
       SET "credited" = "credited" - $1::numeric, "amountPaid" = "amountPaid" + $2::numeric, "updatedAt" = now()
       WHERE "id" = $3`,
      note.total.toFixed(2),
      note.refund.toFixed(2),
      invoice.id,
    );
    await tx.$executeRawUnsafe(`UPDATE "invoices" SET "status" = ${STATUS_FROM_SETTLED} WHERE "id" = $1`, invoice.id);
    await moveCustomerBalance(tx, note.customerId, note.total.minus(note.refund));
    await tx.invoiceEvent.create({
      data: { invoiceId: invoice.id, type: "creditNoteDeleted", values: { number: creditNoteNumber(note.number) }, userId: actor.id },
    });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "creditNoteDeleted",
      item: { type: "invoice", id: invoice.id, ref: `${invoice.numberPrefix}${invoice.number}` },
      values: { number: creditNoteNumber(note.number), amount: moneyString(note.total), customer: invoice.customerName },
    });
  });
  return getInvoice(actor.companyId, ref);
}

