import { Prisma } from "../../generated/prisma/client.js";

/**
 * The entries invoices, payments and expenses make in the books, worked out from
 * the documents in SQL each time the books are read (nothing is copied, so the
 * books always match the documents).
 *
 *   invoice         issued (sent, partly paid or paid), on its issue date:
 *                   Dr customers (total) / Cr sales (before VAT), Cr VAT
 *   creditNote      on its date: Dr sales (before VAT), Dr VAT / Cr customers (part of an
 *                   invoice taken back: a return, a discount after the fact)
 *   creditNoteRefund the same day, when the customer had paid more than is now owed:
 *                   Dr customers / Cr the account the refund came from
 *   payment         on its date: Dr where it went in / Cr customers.
 *                   A cheque goes into "cheques" until it clears.
 *   chequeCleared   the day a cheque cleared: Dr where it went in / Cr cheques
 *   chequeBounced   the day a cheque bounced: Dr customers / Cr cheques (owed again)
 *   expense         on its date: Dr its category (the cost, VAT excluded), Dr VAT input (its
 *                   VAT, if any) / Cr where it was paid from, or Cr suppliers when saved as due
 *   expensePayment  a due expense paid later, on that day: Dr suppliers / Cr where it was paid from
 *   payroll         an approved (or paid) month's salaries, on its accrual day (the month's last
 *                   day, or the day it was paid if earlier): Dr salaries (the cost: pay after
 *                   absence and other deductions, plus the company's insurance share) /
 *                   Cr salaries payable (net), social insurance (both shares), payroll tax,
 *                   employee advances (installments taken off)
 *   payrollPayment  a paid month, on the day it was paid: Dr salaries payable / Cr where each
 *                   employee was paid from
 *   advance         an advance paid to an employee: Dr employee advances / Cr where it came from
 *   stockSold       goods sold leave inventory at their cost (on the sale's date): Dr cost of goods
 *                   sold / Cr inventory; a cancelled sale or a return the other way
 *   stockLoss       stock damaged, or a count short: Dr stock loss / Cr inventory (a count over:
 *                   the other way)
 *   stockValue      opening stock, or what's on hand valued at a new cost: Dr inventory / Cr capital
 *                   (or the other way when it's worth less)
 *   A purchase of goods received into stock (an expense with a receipt movement) is inventory:
 *   Dr inventory instead of its category.
 *
 * Drafts and cancelled invoices make no entry (same rule as the reports).
 */
export type AutoSource =
  | "invoice"
  | "creditNote"
  | "creditNoteRefund"
  | "payment"
  | "chequeCleared"
  | "chequeBounced"
  | "expense"
  | "expensePayment"
  | "payroll"
  | "payrollPayment"
  | "advance"
  | "stockSold"
  | "stockLoss"
  | "stockValue";
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

/** When a month's salaries go into the books: its last day, or the day they were paid if earlier (not before the month). */
export const payrollAccrual = Prisma.raw(
  `GREATEST(r."month", LEAST((r."month" + interval '1 month - 1 day')::date, COALESCE(r."paidOn", (r."month" + interval '1 month - 1 day')::date)))`,
);
/** One payroll line's net pay and cost to the company (see PayrollItem in the schema). */
export const itemNet = Prisma.raw(
  `(it."baseSalary" + it."allowances" + it."bonus" + it."overtime" - it."absenceDeduction" - it."otherDeductions" - it."insurance" - it."incomeTax" - it."advanceDeduction")`,
);
export const itemCost = Prisma.raw(
  `(it."baseSalary" + it."allowances" + it."bonus" + it."overtime" - it."absenceDeduction" - it."otherDeductions" + it."employerInsurance")`,
);
const PAYROLL_POSTED = Prisma.raw(`('approved', 'paid')`);
/** A stock movement's entry: sales (and their reversals), stock lost or found, or value set. */
const STOCK_SOURCE = Prisma.raw(
  `(CASE WHEN m."kind"::text IN ('sale', 'saleCancelled', 'returned', 'returnRemoved') THEN 'stockSold'
         WHEN m."kind"::text IN ('counted', 'damaged') THEN 'stockLoss' ELSE 'stockValue' END)`,
);
/** The account on the other side of inventory for a stock movement. */
const STOCK_OTHER = Prisma.raw(
  `(CASE WHEN m."kind"::text IN ('sale', 'saleCancelled', 'returned', 'returnRemoved') THEN 'cogs'
         WHEN m."kind"::text IN ('counted', 'damaged') THEN 'stockLoss' ELSE 'capital' END)`,
);

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
    SELECT 'creditNote', c."id", c."date", l."key", l."debit", l."credit", l."position"
    FROM "credit_notes" c
    CROSS JOIN LATERAL (VALUES
      ('sales'::text, c."subtotal", 0::numeric, 0),
      ('vat', c."vat", 0::numeric, 1),
      ('customers', 0::numeric, c."total", 2)
    ) ${LINE}
    WHERE c."companyId" = ${companyId} AND (l."debit" > 0 OR l."credit" > 0)

    UNION ALL
    SELECT 'creditNoteRefund', c."id", c."date", l."key", l."debit", l."credit", l."position"
    FROM "credit_notes" c
    CROSS JOIN LATERAL (VALUES
      ('customers'::text, c."refund", 0::numeric, 0),
      (COALESCE(c."refundAccount"::text, 'cashbox'), 0::numeric, c."refund", 1)
    ) ${LINE}
    WHERE c."companyId" = ${companyId} AND c."refund" > 0

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
    SELECT 'chequeBounced', p."id", (p."bouncedAt" AT TIME ZONE 'Africa/Cairo')::date, l."key", l."debit", l."credit", l."position"
    FROM "invoice_payments" p
    CROSS JOIN LATERAL (VALUES
      ('customers'::text, p."amount", 0::numeric, 0),
      ('cheques', 0::numeric, p."amount", 1)
    ) ${LINE}
    WHERE p."companyId" = ${companyId} AND p."method" = 'cheque' AND p."status" = 'bounced' AND p."bouncedAt" IS NOT NULL

    UNION ALL
    SELECT 'expense', e."id", e."date", l."key", l."debit", l."credit", l."position"
    FROM "expenses" e
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN EXISTS (SELECT 1 FROM "stock_movements" sm WHERE sm."expenseId" = e."id") THEN 'inventory' ELSE e."category"::text END,
       e."amount" - e."vat", 0::numeric, 0),
      ('vatInput', e."vat", 0::numeric, 1),
      (CASE WHEN e."paidOn" = e."date" THEN ${paidFrom} ELSE 'suppliers' END, 0::numeric, e."amount", 2)
    ) ${LINE}
    -- No VAT: no VAT line.
    WHERE e."companyId" = ${companyId} AND (l."debit" <> 0 OR l."credit" <> 0)

    UNION ALL
    SELECT 'expensePayment', e."id", e."paidOn", l."key", l."debit", l."credit", l."position"
    FROM "expenses" e
    CROSS JOIN LATERAL (VALUES
      ('suppliers'::text, e."amount", 0::numeric, 0),
      (${paidFrom}, 0::numeric, e."amount", 1)
    ) ${LINE}
    WHERE e."companyId" = ${companyId} AND e."paidOn" IS NOT NULL AND e."paidOn" <> e."date"

    UNION ALL
    SELECT 'payroll', r."id", ${payrollAccrual}, l."key", l."debit", l."credit", l."position"
    FROM "payroll_runs" r
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(${itemCost}), 0) AS "cost", COALESCE(SUM(${itemNet}), 0) AS "net",
             COALESCE(SUM(it."insurance" + it."employerInsurance"), 0) AS "insurance",
             COALESCE(SUM(it."incomeTax"), 0) AS "tax", COALESCE(SUM(it."advanceDeduction"), 0) AS "advances"
      FROM "payroll_items" it WHERE it."runId" = r."id"
    ) t
    CROSS JOIN LATERAL (VALUES
      ('salaries'::text, t."cost", 0::numeric, 0),
      ('salariesPayable', 0::numeric, t."net", 1),
      ('socialInsurance', 0::numeric, t."insurance", 2),
      ('payrollTax', 0::numeric, t."tax", 3),
      ('employeeAdvances', 0::numeric, t."advances", 4)
    ) ${LINE}
    WHERE r."companyId" = ${companyId} AND r."status" IN ${PAYROLL_POSTED} AND (l."debit" > 0 OR l."credit" > 0)

    UNION ALL
    SELECT 'payrollPayment', r."id", r."paidOn", l."key", l."debit", l."credit", l."position"
    FROM "payroll_runs" r
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(${itemNet}), 0) AS "net",
             COALESCE(SUM(${itemNet}) FILTER (WHERE it."payAccount" = 'bank'), 0) AS "bank",
             COALESCE(SUM(${itemNet}) FILTER (WHERE it."payAccount" = 'cashbox'), 0) AS "cashbox",
             COALESCE(SUM(${itemNet}) FILTER (WHERE it."payAccount" = 'wallet'), 0) AS "wallet"
      FROM "payroll_items" it WHERE it."runId" = r."id"
    ) t
    CROSS JOIN LATERAL (VALUES
      ('salariesPayable'::text, t."net", 0::numeric, 0),
      ('bank', 0::numeric, t."bank", 1),
      ('cashbox', 0::numeric, t."cashbox", 2),
      ('wallet', 0::numeric, t."wallet", 3)
    ) ${LINE}
    WHERE r."companyId" = ${companyId} AND r."status" = 'paid' AND r."paidOn" IS NOT NULL AND (l."debit" > 0 OR l."credit" > 0)

    UNION ALL
    SELECT 'advance', a."id", a."date", l."key", l."debit", l."credit", l."position"
    FROM "employee_advances" a
    CROSS JOIN LATERAL (VALUES
      ('employeeAdvances'::text, a."amount", 0::numeric, 0),
      (a."paidFrom"::text, 0::numeric, a."amount", 1)
    ) ${LINE}
    WHERE a."companyId" = ${companyId}

    UNION ALL
    SELECT ${STOCK_SOURCE}, m."id", m."date", l."key", l."debit", l."credit", l."position"
    FROM "stock_movements" m
    CROSS JOIN LATERAL (SELECT ${STOCK_OTHER} AS "other") k
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN m."value" > 0 THEN 'inventory' ELSE k."other" END, ABS(m."value"), 0::numeric, 0),
      (CASE WHEN m."value" > 0 THEN k."other" ELSE 'inventory' END, 0::numeric, ABS(m."value"), 1)
    ) ${LINE}
    WHERE m."companyId" = ${companyId} AND m."value" IS NOT NULL AND m."value" <> 0
      -- Goods received (and undone) go into the books as their purchase.
      AND m."kind"::text NOT IN ('received', 'receiptRemoved')`;
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
  const creditText = Prisma.raw(
    `'CN-' || lpad(c."number"::text, GREATEST(4, length(c."number"::text)), '0') || ' ' || i."numberPrefix" || i."number" || ' ' || i."customerName"`,
  );
  return Prisma.sql`
    SELECT 'invoice'::text AS "source", i."id" AS "entryId", i."issueDate" AS "date", i."createdAt" AS "at",
           'posted'::text AS "status", i."total" AS "amount", i."numberPrefix" || i."number" || ' ' || i."customerName" AS "text"
    FROM "invoices" i
    WHERE i."companyId" = ${companyId} AND i."status" IN ${ISSUED} AND i."total" > 0

    UNION ALL
    SELECT 'creditNote', c."id", c."date", c."createdAt", 'posted', c."total", ${creditText}
    FROM "credit_notes" c JOIN "invoices" i ON i."id" = c."invoiceId"
    WHERE c."companyId" = ${companyId}

    UNION ALL
    SELECT 'creditNoteRefund', c."id", c."date", c."createdAt", 'posted', c."refund", ${creditText}
    FROM "credit_notes" c JOIN "invoices" i ON i."id" = c."invoiceId"
    WHERE c."companyId" = ${companyId} AND c."refund" > 0

    UNION ALL
    SELECT 'payment', p."id", p."date", p."createdAt", 'posted', p."amount", ${paymentText}
    FROM "invoice_payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId}

    UNION ALL
    SELECT 'chequeCleared', p."id", ${clearedOn}, p."clearedAt", 'posted', p."amount", ${paymentText}
    FROM "invoice_payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId} AND p."method" = 'cheque' AND p."status" = 'cleared' AND p."clearedAt" IS NOT NULL

    UNION ALL
    SELECT 'chequeBounced', p."id", (p."bouncedAt" AT TIME ZONE 'Africa/Cairo')::date, p."bouncedAt", 'posted', p."amount", ${paymentText}
    FROM "invoice_payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
    WHERE p."companyId" = ${companyId} AND p."method" = 'cheque' AND p."status" = 'bounced' AND p."bouncedAt" IS NOT NULL

    UNION ALL
    SELECT 'expense', e."id", e."date", e."createdAt", 'posted', e."amount", ${expenseText}
    FROM "expenses" e
    WHERE e."companyId" = ${companyId}

    UNION ALL
    SELECT 'expensePayment', e."id", e."paidOn", COALESCE(e."paidAt", e."createdAt"), 'posted', e."amount", ${expenseText}
    FROM "expenses" e
    WHERE e."companyId" = ${companyId} AND e."paidOn" IS NOT NULL AND e."paidOn" <> e."date"

    UNION ALL
    SELECT 'payroll', r."id", ${payrollAccrual}, COALESCE(r."approvedAt", r."createdAt"), 'posted',
           (SELECT COALESCE(SUM(${itemCost}), 0) FROM "payroll_items" it WHERE it."runId" = r."id"),
           'payroll ' || to_char(r."month", 'YYYY-MM')
    FROM "payroll_runs" r
    WHERE r."companyId" = ${companyId} AND r."status" IN ${PAYROLL_POSTED}

    UNION ALL
    SELECT 'payrollPayment', r."id", r."paidOn", COALESCE(r."paidAt", r."createdAt"), 'posted',
           (SELECT COALESCE(SUM(${itemNet}), 0) FROM "payroll_items" it WHERE it."runId" = r."id"),
           'payroll ' || to_char(r."month", 'YYYY-MM')
    FROM "payroll_runs" r
    WHERE r."companyId" = ${companyId} AND r."status" = 'paid' AND r."paidOn" IS NOT NULL

    UNION ALL
    SELECT 'advance', a."id", a."date", a."createdAt", 'posted', a."amount", emp."name" || ' ' || COALESCE(a."note", '')
    FROM "employee_advances" a JOIN "employees" emp ON emp."id" = a."employeeId"
    WHERE a."companyId" = ${companyId}

    UNION ALL
    SELECT ${STOCK_SOURCE}, m."id", m."date", m."createdAt", 'posted', ABS(m."value"), p."name"
    FROM "stock_movements" m JOIN "products" p ON p."id" = m."productId"
    WHERE m."companyId" = ${companyId} AND m."value" IS NOT NULL AND m."value" <> 0
      AND m."kind"::text NOT IN ('received', 'receiptRemoved')

    UNION ALL
    SELECT 'manual', j."id", j."date", j."createdAt", j."status"::text,
           (SELECT COALESCE(SUM(jl."debit"), 0) FROM "journal_lines" jl WHERE jl."entryId" = j."id"),
           'JE-' || lpad(j."number"::text, GREATEST(4, length(j."number"::text)), '0') || ' ' || j."memo"
    FROM "journal_entries" j
    WHERE j."companyId" = ${companyId}`;
}
