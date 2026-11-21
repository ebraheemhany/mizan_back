import { Prisma } from "../../generated/prisma/client.js";

/**
 * The entries invoices, payments and expenses make in the books, worked out from
 * the documents in SQL each time the books are read (nothing is copied, so the
 * books always match the documents).
 *
 *   invoice         issued (sent, partly paid or paid), on its issue date:
 *                   Dr customers (total) / Cr sales (before VAT), Cr VAT
 *   payment         on its date: Dr where it went in / Cr customers.
 *                   A cheque goes into "cheques" until it clears.
 *   chequeCleared   the day a cheque cleared: Dr where it went in / Cr cheques
 *   expense         on its date: Dr its category / Cr where it was paid from,
 *                   or Cr suppliers when it was saved as due
 *   expensePayment  a due expense paid later, on that day: Dr suppliers / Cr where it was paid from
 *
 * Drafts and cancelled invoices make no entry (same rule as the reports).
 */
export type AutoSource = "invoice" | "payment" | "chequeCleared" | "expense" | "expensePayment";
export type EntrySource = AutoSource | "manual";

/** Where a customer's payment went in: the account picked on it, else by method. */
const receivedInto = Prisma.raw(
  `COALESCE(p."account"::text, CASE p."method" WHEN 'cash' THEN 'cashbox' WHEN 'vodafoneCash' THEN 'wallet' ELSE 'bank' END)`,
);
/** Where an expense was paid from (a card is the bank account; not given = the cash box). */
const paidFrom = Prisma.raw(`CASE e."paidFrom" WHEN 'bank' THEN 'bank' WHEN 'card' THEN 'bank' ELSE 'cashbox' END`);
/** The day a cheque cleared, in Egypt. */
const clearedOn = Prisma.raw(`(p."clearedAt" AT TIME ZONE 'Africa/Cairo')::date`);
const ISSUED = Prisma.raw(`('sent', 'partial', 'paid')`);
const LINE = Prisma.raw(`AS l("key", "debit", "credit", "position")`);

/** Every line of every automatic entry: source, entryId, date, key (built-in account), debit, credit, position. */
export function autoLines(companyId: string) {
  return Prisma.sql`
    SELECT 'invoice'::text AS "source", i."id" AS "entryId", i."issueDate" AS "date", l."key", l."debit", l."credit", l."position"
    FROM "invoices" i
    CROSS JOIN LATERAL (VALUES
      ('customers'::text, i."total", 0::numeric, 0),
      ('sales', 0::numeric, i."subtotal", 1),
      ('vat', 0::numeric, i."vat", 2)
    ) ${LINE}
    WHERE i."companyId" = ${companyId} AND i."status" IN ${ISSUED} AND (l."debit" > 0 OR l."credit" > 0)

    UNION ALL
    SELECT 'payment', p."id", p."date", l."key", l."debit", l."credit", l."position"
    FROM "invoice_payments" p
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN p."method" = 'cheque' THEN 'cheques' ELSE ${receivedInto} END, p."amount", 0::numeric, 0),
      ('customers', 0::numeric, p."amount", 1)
    ) ${LINE}
    WHERE p."companyId" = ${companyId}

    UNION ALL
    SELECT 'chequeCleared', p."id", ${clearedOn}, l."key", l."debit", l."credit", l."position"
    FROM "invoice_payments" p
    CROSS JOIN LATERAL (VALUES
      (${receivedInto}, p."amount", 0::numeric, 0),
      ('cheques', 0::numeric, p."amount", 1)
    ) ${LINE}
    WHERE p."companyId" = ${companyId} AND p."method" = 'cheque' AND p."status" = 'cleared' AND p."clearedAt" IS NOT NULL

    UNION ALL
    SELECT 'expense', e."id", e."date", l."key", l."debit", l."credit", l."position"
    FROM "expenses" e
    CROSS JOIN LATERAL (VALUES
      (e."category"::text, e."amount", 0::numeric, 0),
      (CASE WHEN e."paidOn" = e."date" THEN ${paidFrom} ELSE 'suppliers' END, 0::numeric, e."amount", 1)
    ) ${LINE}
    WHERE e."companyId" = ${companyId}

    UNION ALL
    SELECT 'expensePayment', e."id", e."paidOn", l."key", l."debit", l."credit", l."position"
    FROM "expenses" e
    CROSS JOIN LATERAL (VALUES
      ('suppliers'::text, e."amount", 0::numeric, 0),
      (${paidFrom}, 0::numeric, e."amount", 1)
    ) ${LINE}
    WHERE e."companyId" = ${companyId} AND e."paidOn" IS NOT NULL AND e."paidOn" <> e."date"`;
}

/**
 * One row per entry (automatic and manual): source, entryId, date, "at" (when it
 * happened, for ordering within a day), status, amount (its total debit) and the
 * text the journal search looks in. Same conditions as autoLines.
 */
export function entryHeaders(companyId: string) {
  const paymentText = Prisma.raw(
    `'PAY-' || lpad(p."number"::text, GREATEST(4, length(p."number"::text)), '0') || ' ' || i."numberPrefix" || i."number" || ' ' || i."customerName"`,
  );
  const expenseText = Prisma.raw(`e."title" || ' ' || COALESCE(e."vendor", '')`);
  return Prisma.sql`
    SELECT 'invoice'::text AS "source", i."id" AS "entryId", i."issueDate" AS "date", i."createdAt" AS "at",
           'posted'::text AS "status", i."total" AS "amount", i."numberPrefix" || i."number" || ' ' || i."customerName" AS "text"
    FROM "invoices" i
    WHERE i."companyId" = ${companyId} AND i."status" IN ${ISSUED} AND i."total" > 0

    UNION ALL
    SELECT 'payment', p."id", p."date", p."createdAt", 'posted', p."amount", ${paymentText}
    FROM "invoice_payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId}

    UNION ALL
    SELECT 'chequeCleared', p."id", ${clearedOn}, p."clearedAt", 'posted', p."amount", ${paymentText}
    FROM "invoice_payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId} AND p."method" = 'cheque' AND p."status" = 'cleared' AND p."clearedAt" IS NOT NULL

    UNION ALL
    SELECT 'expense', e."id", e."date", e."createdAt", 'posted', e."amount", ${expenseText}
    FROM "expenses" e
    WHERE e."companyId" = ${companyId}

    UNION ALL
    SELECT 'expensePayment', e."id", e."paidOn", COALESCE(e."paidAt", e."createdAt"), 'posted', e."amount", ${expenseText}
    FROM "expenses" e
    WHERE e."companyId" = ${companyId} AND e."paidOn" IS NOT NULL AND e."paidOn" <> e."date"

    UNION ALL
    SELECT 'manual', j."id", j."date", j."createdAt", j."status"::text,
           (SELECT COALESCE(SUM(jl."debit"), 0) FROM "journal_lines" jl WHERE jl."entryId" = j."id"),
           'JE-' || lpad(j."number"::text, GREATEST(4, length(j."number"::text)), '0') || ' ' || j."memo"
    FROM "journal_entries" j
    WHERE j."companyId" = ${companyId}`;
}
