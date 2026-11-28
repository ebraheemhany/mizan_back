-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementKind" ADD VALUE 'costed';
ALTER TYPE "StockMovementKind" ADD VALUE 'receiptRemoved';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "cost" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "expenseId" TEXT,
ADD COLUMN     "unitCost" DECIMAL(14,4),
ADD COLUMN     "value" DECIMAL(14,2);

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_expenseId_key" ON "stock_movements"("expenseId");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
