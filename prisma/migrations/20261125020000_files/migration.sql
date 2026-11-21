-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('logo', 'receipt');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "logoFileId" TEXT;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "receiptFileId" TEXT;

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "name" TEXT,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "files_companyId_idx" ON "files"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "companies_logoFileId_key" ON "companies"("logoFileId");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_receiptFileId_key" ON "expenses"("receiptFileId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_logoFileId_fkey" FOREIGN KEY ("logoFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_receiptFileId_fkey" FOREIGN KEY ("receiptFileId") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
