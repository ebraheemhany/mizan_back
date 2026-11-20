-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('urgent', 'important', 'normal');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('meeting', 'quote', 'collection', 'visit', 'deadline', 'admin');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "priority" "TaskPriority" NOT NULL DEFAULT 'normal',
    "kind" "TaskKind" NOT NULL DEFAULT 'admin',
    "completedOn" DATE,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT,
    "createdById" TEXT,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_companyId_dueDate_idx" ON "tasks"("companyId", "dueDate");

-- CreateIndex
CREATE INDEX "tasks_companyId_completedOn_idx" ON "tasks"("companyId", "completedOn");

-- CreateIndex
CREATE INDEX "tasks_customerId_idx" ON "tasks"("customerId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
