-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('service', 'product');

-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('software', 'support', 'consulting', 'devices', 'network', 'accessories');

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "code" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "category" "ProductCategory" NOT NULL,
    "stock" INTEGER,
    "lowStockAt" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "products_companyId_createdAt_idx" ON "products"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "products_companyId_code_key" ON "products"("companyId", "code");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
