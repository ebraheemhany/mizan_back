-- Payments get a receipt number, status (cheques start pending), receiving
-- account and reference, and belong to a company directly.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('cleared', 'pending');

-- CreateEnum
CREATE TYPE "ReceivingAccount" AS ENUM ('bank', 'cashbox', 'wallet');

-- AlterEnum
ALTER TYPE "InvoiceEventType" ADD VALUE 'paymentRemoved';

-- AlterEnum (PostgreSQL 12+ allows several values in one migration)
ALTER TYPE "PaymentMethod" ADD VALUE 'instapay';
ALTER TYPE "PaymentMethod" ADD VALUE 'vodafoneCash';
ALTER TYPE "PaymentMethod" ADD VALUE 'cheque';

-- DropIndex
DROP INDEX "invoice_payments_date_idx";

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "paymentNextNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: new columns, nullable first so existing payments can be filled in.
ALTER TABLE "invoice_payments"
  ADD COLUMN "account" "ReceivingAccount",
  ADD COLUMN "clearedAt" TIMESTAMPTZ(3),
  ADD COLUMN "companyId" TEXT,
  ADD COLUMN "number" INTEGER,
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'cleared';

-- Existing payments: company from their invoice, numbered in the order they were recorded.
UPDATE "invoice_payments" p
SET "companyId" = i."companyId"
FROM "invoices" i
WHERE i."id" = p."invoiceId";

UPDATE "invoice_payments" p
SET "number" = n.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "companyId" ORDER BY "createdAt", "id") AS rn
  FROM "invoice_payments"
) n
WHERE n."id" = p."id";

UPDATE "invoice_payments" SET "clearedAt" = "createdAt" WHERE "status" = 'cleared';

-- Continue numbering after the existing payments.
UPDATE "companies" c
SET "paymentNextNumber" = m.next
FROM (
  SELECT "companyId", MAX("number") + 1 AS next FROM "invoice_payments" GROUP BY "companyId"
) m
WHERE m."companyId" = c."id";

ALTER TABLE "invoice_payments"
  ALTER COLUMN "companyId" SET NOT NULL,
  ALTER COLUMN "number" SET NOT NULL;

-- CreateIndex
CREATE INDEX "invoice_payments_companyId_date_idx" ON "invoice_payments"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_companyId_number_key" ON "invoice_payments"("companyId", "number");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
