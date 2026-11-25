-- CreateEnum
CREATE TYPE "PaymentClaimStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateEnum
CREATE TYPE "OnlinePaymentStatus" AS ENUM ('pending', 'paid', 'failed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceEventType" ADD VALUE 'paymentClaimed';
ALTER TYPE "InvoiceEventType" ADD VALUE 'paymentClaimRejected';

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN     "proofFileId" TEXT;

-- CreateTable
CREATE TABLE "payment_setups" (
    "companyId" TEXT NOT NULL,
    "bankName" TEXT,
    "accountName" TEXT,
    "accountNumber" TEXT,
    "instapayAddress" TEXT,
    "walletNumber" TEXT,
    "instructions" TEXT,
    "paymobSecretKey" TEXT,
    "paymobPublicKey" TEXT,
    "paymobHmacSecret" TEXT,
    "paymobIntegrationId" INTEGER,
    "paymobLive" BOOLEAN NOT NULL DEFAULT false,
    "paymobConnectedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_setups_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "payment_claims" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "date" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "payerName" TEXT,
    "note" TEXT,
    "status" "PaymentClaimStatus" NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "receiptFileId" TEXT NOT NULL,
    "reviewedById" TEXT,
    "paymentId" TEXT,

    CONSTRAINT "payment_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_payments" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "OnlinePaymentStatus" NOT NULL DEFAULT 'pending',
    "gatewayOrderId" TEXT NOT NULL,
    "transactionId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT,

    CONSTRAINT "online_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_claims_receiptFileId_key" ON "payment_claims"("receiptFileId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_claims_paymentId_key" ON "payment_claims"("paymentId");

-- CreateIndex
CREATE INDEX "payment_claims_companyId_status_idx" ON "payment_claims"("companyId", "status");

-- CreateIndex
CREATE INDEX "payment_claims_invoiceId_idx" ON "payment_claims"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_paymentId_key" ON "online_payments"("paymentId");

-- CreateIndex
CREATE INDEX "online_payments_invoiceId_idx" ON "online_payments"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_companyId_gatewayOrderId_key" ON "online_payments"("companyId", "gatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_proofFileId_key" ON "invoice_payments"("proofFileId");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_proofFileId_fkey" FOREIGN KEY ("proofFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_setups" ADD CONSTRAINT "payment_setups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_receiptFileId_fkey" FOREIGN KEY ("receiptFileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "invoice_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "invoice_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
