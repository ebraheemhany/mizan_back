-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EGP', 'USD', 'SAR', 'AED');

-- CreateEnum
CREATE TYPE "InvoiceTemplate" AS ENUM ('classic', 'modern', 'minimal');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "address" TEXT,
ADD COLUMN     "commercialRegister" TEXT,
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'EGP',
ADD COLUMN     "fiscalStartMonth" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "integrations" JSONB NOT NULL DEFAULT '{"whatsapp":false,"paymentGateway":false,"eta":false,"calendar":false}',
ADD COLUMN     "invoiceFooter" TEXT,
ADD COLUMN     "invoiceNextNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-',
ADD COLUMN     "invoiceTemplate" "InvoiceTemplate" NOT NULL DEFAULT 'classic',
ADD COLUMN     "notifications" JSONB NOT NULL DEFAULT '{"overdueInvoice":true,"newPayment":true,"taskReminder":true,"weeklyDigest":false}',
ADD COLUMN     "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "quoteNextNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "quotePrefix" TEXT NOT NULL DEFAULT 'Q-',
ADD COLUMN     "taxNumber" TEXT,
ADD COLUMN     "vatEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "withholdingEnabled" BOOLEAN NOT NULL DEFAULT false;
