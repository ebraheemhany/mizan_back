import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";

type Tx = Prisma.TransactionClient;

/**
 * Links an accepted quote to the invoice just made from it. Runs inside the
 * invoice's transaction: any error here rolls the new invoice back too.
 *
 * The status and "not converted yet" conditions are part of the update itself, so
 * two conversions of the same quote at the same moment can't both succeed.
 */
export async function markQuoteConverted(
  tx: Tx,
  actor: { id: string; companyId: string },
  quoteNumber: number,
  invoice: { id: string; number: number; displayNumber: string; customerId: string },
) {
  // The invoice must be for the quote's customer: "converted" means this quote was
  // invoiced to the customer who accepted it. (A quote whose customer was deleted has
  // none, and can be invoiced to whoever takes it over.)
  const { count } = await tx.quote.updateMany({
    where: {
      companyId: actor.companyId,
      number: quoteNumber,
      status: "accepted",
      convertedInvoiceId: null,
      OR: [{ customerId: invoice.customerId }, { customerId: null }],
    },
    data: { convertedInvoiceId: invoice.id },
  });

  if (count === 0) {
    const quote = await tx.quote.findFirst({
      where: { companyId: actor.companyId, number: quoteNumber },
      select: { convertedInvoiceId: true, status: true, customerId: true },
    });
    if (!quote) throw notFound("Quote");
    if (quote.convertedInvoiceId) {
      throw new AppError(409, "QUOTE_ALREADY_CONVERTED", "This quote was already turned into an invoice", {
        field: "fromQuote",
      });
    }
    if (quote.status !== "accepted") {
      throw new AppError(409, "QUOTE_NOT_ACCEPTED", "Only an accepted quote can be turned into an invoice", {
        field: "fromQuote",
      });
    }
    throw new AppError(409, "QUOTE_CUSTOMER_MISMATCH", "The invoice must be for the quote's customer", {
      field: "customerId",
    });
  }

  const quote = await tx.quote.findFirstOrThrow({
    where: { companyId: actor.companyId, number: quoteNumber },
    select: { id: true },
  });
  await tx.quoteEvent.create({
    data: {
      quoteId: quote.id,
      type: "converted",
      values: { invoiceNumber: invoice.number, displayNumber: invoice.displayNumber },
      userId: actor.id,
    },
  });
}
