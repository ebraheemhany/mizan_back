-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "RecurringStatus" AS ENUM ('active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "RecurringEndMode" AS ENUM ('never', 'date', 'count');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "recurringId" TEXT,
ADD COLUMN     "recurringRunDate" DATE;

-- CreateTable
CREATE TABLE "recurring_invoices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL,
    "startDate" DATE NOT NULL,
    "nextIndex" INTEGER NOT NULL DEFAULT 0,
    "nextDate" DATE,
    "endMode" "RecurringEndMode" NOT NULL DEFAULT 'never',
    "endDate" DATE,
    "maxCount" INTEGER,
    "status" "RecurringStatus" NOT NULL DEFAULT 'active',
    "paymentTermsDays" INTEGER NOT NULL,
    "autoSend" BOOLEAN NOT NULL,
    "notes" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "vat" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "generatedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "recurring_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoice_lines" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "recurringId" TEXT NOT NULL,
    "productId" TEXT,

    CONSTRAINT "recurring_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_invoices_companyId_status_idx" ON "recurring_invoices"("companyId", "status");

-- CreateIndex
CREATE INDEX "recurring_invoices_status_nextDate_idx" ON "recurring_invoices"("status", "nextDate");

-- CreateIndex
CREATE INDEX "recurring_invoices_customerId_idx" ON "recurring_invoices"("customerId");

-- CreateIndex
CREATE INDEX "recurring_invoice_lines_recurringId_idx" ON "recurring_invoice_lines"("recurringId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_recurringId_recurringRunDate_key" ON "invoices"("recurringId", "recurringRunDate");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "recurring_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_recurringId_fkey" FOREIGN KEY ("recurringId") REFERENCES "recurring_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoice_lines" ADD CONSTRAINT "recurring_invoice_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
