-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('opening', 'sale', 'saleCancelled', 'returned', 'returnRemoved', 'received', 'counted', 'damaged');

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "stock" SET DATA TYPE DECIMAL(14,3),
ALTER COLUMN "lowStockAt" SET DATA TYPE DECIMAL(14,3);

-- AlterTable
ALTER TABLE "credit_note_lines" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "balance" DECIMAL(14,3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "creditNoteId" TEXT,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "stock_movements_companyId_createdAt_idx" ON "stock_movements"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "credit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Products that already had stock: that balance opens their log.
INSERT INTO "stock_movements" ("id", "kind", "date", "quantity", "balance", "companyId", "productId", "createdAt")
SELECT gen_random_uuid()::text, 'opening', ("createdAt" AT TIME ZONE 'Africa/Cairo')::date, "stock", "stock", "companyId", "id", "createdAt"
FROM "products"
WHERE "type" = 'product' AND "stock" IS NOT NULL AND "stock" <> 0;
