-- AlterEnum
ALTER TYPE "InvoiceEventType" ADD VALUE 'chequeBounced';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'bounced';

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN     "bouncedAt" TIMESTAMPTZ(3);
