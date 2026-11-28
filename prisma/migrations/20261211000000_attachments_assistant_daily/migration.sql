-- AlterEnum
ALTER TYPE "FileKind" ADD VALUE 'attachment';

-- AlterTable
ALTER TABLE "assistant_usage" ADD COLUMN     "day" TEXT,
ADD COLUMN     "dayMessages" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "invoice_attachments" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "invoice_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_attachments_fileId_key" ON "invoice_attachments"("fileId");

-- CreateIndex
CREATE INDEX "invoice_attachments_invoiceId_idx" ON "invoice_attachments"("invoiceId");

-- AddForeignKey
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_attachments" ADD CONSTRAINT "invoice_attachments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
