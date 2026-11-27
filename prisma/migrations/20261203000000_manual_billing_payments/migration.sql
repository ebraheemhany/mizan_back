-- AlterTable
ALTER TABLE "billing_payments" ADD COLUMN     "manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT;
