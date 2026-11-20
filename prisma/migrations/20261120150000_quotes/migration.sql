-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'sent', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "QuoteEventType" AS ENUM ('created', 'sent', 'accepted', 'rejected', 'converted');

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "numberPrefix" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "issueDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerTaxNumber" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerCity" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "vat" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "publicToken" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "convertedInvoiceId" TEXT,
    "createdById" TEXT,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productId" TEXT,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_events" (
    "id" TEXT NOT NULL,
    "type" "QuoteEventType" NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quoteId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "quote_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_publicToken_key" ON "quotes"("publicToken");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_convertedInvoiceId_key" ON "quotes"("convertedInvoiceId");

-- CreateIndex
CREATE INDEX "quotes_companyId_status_idx" ON "quotes"("companyId", "status");

-- CreateIndex
CREATE INDEX "quotes_companyId_issueDate_idx" ON "quotes"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "quotes_customerId_idx" ON "quotes"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_companyId_number_key" ON "quotes"("companyId", "number");

-- CreateIndex
CREATE INDEX "quote_lines_quoteId_idx" ON "quote_lines"("quoteId");

-- CreateIndex
CREATE INDEX "quote_events_quoteId_idx" ON "quote_events"("quoteId");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_convertedInvoiceId_fkey" FOREIGN KEY ("convertedInvoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_events" ADD CONSTRAINT "quote_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
