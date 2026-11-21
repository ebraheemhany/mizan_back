-- CreateEnum
CREATE TYPE "PlanId" AS ENUM ('free', 'pro', 'business');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'pastDue', 'ended');

-- CreateEnum
CREATE TYPE "BillingPaymentKind" AS ENUM ('subscribe', 'upgrade', 'renewal');

-- CreateEnum
CREATE TYPE "BillingPaymentStatus" AS ENUM ('pending', 'paid', 'failed');

-- CreateTable
CREATE TABLE "subscriptions" (
    "companyId" TEXT NOT NULL,
    "plan" "PlanId" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" DATE NOT NULL,
    "currentPeriodEnd" DATE NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "nextPlan" "PlanId",
    "cardToken" TEXT,
    "cardMasked" TEXT,
    "cardBrand" TEXT,
    "renewalAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "BillingPaymentKind" NOT NULL,
    "plan" "PlanId" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'pending',
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "periodStart" DATE,
    "periodEnd" DATE,
    "gatewayOrderId" TEXT,
    "gatewayTransactionId" TEXT,
    "failureReason" TEXT,
    "returnUrl" TEXT,
    "cardToken" TEXT,
    "cardMasked" TEXT,
    "cardBrand" TEXT,
    "renewalKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMPTZ(3),

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_number_key" ON "billing_payments"("number");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_gatewayOrderId_key" ON "billing_payments"("gatewayOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_renewalKey_key" ON "billing_payments"("renewalKey");

-- CreateIndex
CREATE INDEX "billing_payments_companyId_createdAt_idx" ON "billing_payments"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_payments_status_createdAt_idx" ON "billing_payments"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
