-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "supplierId" TEXT,
ADD COLUMN     "vat" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "taxNumber" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_companyId_name_idx" ON "suppliers"("companyId", "name");

-- CreateIndex
CREATE INDEX "expenses_supplierId_idx" ON "expenses"("supplierId");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing expenses: each company's vendor names become its suppliers (one per name,
-- case and outer spaces aside, spelled as first typed), and the expenses point to them.
INSERT INTO "suppliers" ("id", "name", "companyId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, v."name", v."companyId", v."createdAt", CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON ("companyId", lower(btrim("vendor")))
    "companyId", btrim("vendor") AS "name", "createdAt"
  FROM "expenses"
  WHERE "vendor" IS NOT NULL AND btrim("vendor") <> ''
  ORDER BY "companyId", lower(btrim("vendor")), "createdAt"
) v;

UPDATE "expenses" e
SET "supplierId" = s."id"
FROM "suppliers" s
WHERE s."companyId" = e."companyId"
  AND e."vendor" IS NOT NULL
  AND lower(s."name") = lower(btrim(e."vendor"));
