-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'sent', 'partial', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'bank', 'card');

-- CreateEnum
CREATE TYPE "InvoiceEventType" AS ENUM ('created', 'sent', 'viewed', 'reminderSent', 'payment', 'cancelled');

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "numberPrefix" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "paymentTermsDays" INTEGER NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerTaxNumber" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerCity" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "vat" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "publicToken" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "date" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_events" (
    "id" TEXT NOT NULL,
    "type" "InvoiceEventType" NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invoiceId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "invoice_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_publicToken_key" ON "invoices"("publicToken");

-- CreateIndex
CREATE INDEX "invoices_companyId_status_idx" ON "invoices"("companyId", "status");

-- CreateIndex
CREATE INDEX "invoices_companyId_issueDate_idx" ON "invoices"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "invoices_customerId_idx" ON "invoices"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_companyId_number_key" ON "invoices"("companyId", "number");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_payments_date_idx" ON "invoice_payments"("date");

-- CreateIndex
CREATE INDEX "invoice_events_invoiceId_idx" ON "invoice_events"("invoiceId");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
