// A document that is at ETA (being checked, or valid there) can't be changed or removed in
// Mizan first: it has to be cancelled at ETA. Kept apart from eta.service so invoices and
// credit notes can use it without importing the rest of ETA.
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";

type Db = Pick<Prisma.TransactionClient, "etaSubmission">;

export async function assertNotAtEta(db: Db, where: { invoiceId: string } | { creditNoteId: string }) {
  const latest = await db.etaSubmission.findFirst({
    where,
    orderBy: { submittedAt: "desc" },
    select: { status: true },
  });
  if (latest && (latest.status === "submitted" || latest.status === "valid")) {
    throw new AppError(409, "ETA_DOCUMENT_ACTIVE", "It is registered at the tax authority: cancel it there first");
  }
}
