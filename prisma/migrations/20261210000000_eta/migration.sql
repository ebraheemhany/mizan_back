-- CreateEnum
CREATE TYPE "EtaPartyType" AS ENUM ('B', 'P', 'F');

-- CreateEnum
CREATE TYPE "EtaCodeType" AS ENUM ('GS1', 'EGS');

-- CreateEnum
CREATE TYPE "EtaEnvironment" AS ENUM ('preprod', 'production');

-- CreateEnum
CREATE TYPE "EtaStatus" AS ENUM ('submitted', 'valid', 'invalid', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "buildingNumber" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "etaType" "EtaPartyType",
ADD COLUMN     "governorate" TEXT,
ADD COLUMN     "nationalId" TEXT,
ADD COLUMN     "street" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "etaCode" TEXT,
ADD COLUMN     "etaCodeType" "EtaCodeType",
ADD COLUMN     "etaUnit" TEXT;

-- CreateTable
CREATE TABLE "eta_setups" (
    "companyId" TEXT NOT NULL,
    "environment" "EtaEnvironment" NOT NULL DEFAULT 'preprod',
    "clientId" TEXT,
    "clientSecret" TEXT,
    "activityCode" TEXT,
    "branchId" TEXT NOT NULL DEFAULT '0',
    "country" TEXT NOT NULL DEFAULT 'EG',
    "governorate" TEXT,
    "regionCity" TEXT,
    "street" TEXT,
    "buildingNumber" TEXT,
    "postalCode" TEXT,
    "floor" TEXT,
    "room" TEXT,
    "landmark" TEXT,
    "additionalInfo" TEXT,
    "defaultCodeType" "EtaCodeType",
    "defaultCode" TEXT,
    "defaultUnit" TEXT NOT NULL DEFAULT 'EA',
    "verifiedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "eta_setups_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "eta_submissions" (
    "id" TEXT NOT NULL,
    "environment" "EtaEnvironment" NOT NULL,
    "status" "EtaStatus" NOT NULL,
    "uuid" TEXT,
    "longId" TEXT,
    "submissionId" TEXT,
    "internalId" TEXT NOT NULL,
    "errors" JSONB,
    "document" JSONB NOT NULL,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMPTZ(3),
    "cancelRequestedAt" TIMESTAMPTZ(3),
    "total" DECIMAL(19,5),
    "createdById" TEXT,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "creditNoteId" TEXT,

    CONSTRAINT "eta_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eta_submissions_invoiceId_submittedAt_idx" ON "eta_submissions"("invoiceId", "submittedAt");

-- CreateIndex
CREATE INDEX "eta_submissions_creditNoteId_submittedAt_idx" ON "eta_submissions"("creditNoteId", "submittedAt");

-- CreateIndex
CREATE INDEX "eta_submissions_companyId_status_idx" ON "eta_submissions"("companyId", "status");

-- AddForeignKey
ALTER TABLE "eta_setups" ADD CONSTRAINT "eta_setups_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eta_submissions" ADD CONSTRAINT "eta_submissions_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
