-- CreateEnum
CREATE TYPE "DealStage" AS ENUM ('lead', 'contacted', 'proposal', 'negotiation', 'won');

-- CreateEnum
CREATE TYPE "DealLossReason" AS ENUM ('price', 'competitor', 'postponed', 'noResponse', 'noNeed', 'other');

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "stage" "DealStage" NOT NULL,
    "closeDate" DATE NOT NULL,
    "notes" TEXT,
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "awaitingReply" BOOLEAN NOT NULL DEFAULT false,
    "followUpDate" DATE,
    "wonAt" TIMESTAMPTZ(3),
    "lostOn" DATE,
    "lostReason" "DealLossReason",
    "lostNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "ownerId" TEXT,
    "createdById" TEXT,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deals_companyId_stage_idx" ON "deals"("companyId", "stage");

-- CreateIndex
CREATE INDEX "deals_customerId_idx" ON "deals"("customerId");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
