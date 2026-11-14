import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { withoutUndefined } from "../../lib/object.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import {
  createCustomerSchema,
  type CreateCustomerInput,
  type CustomerStatus,
  type ListCustomersQuery,
  type UpdateCustomerInput,
} from "./customers.schemas.js";

/** A customer with no invoice, payment or edit for this long counts as inactive. */
export const INACTIVE_AFTER_DAYS = 90;
const EXPORT_LIMIT = 5000;

const customerSelect = {
  id: true,
  name: true,
  contactName: true,
  phone: true,
  email: true,
  city: true,
  taxNumber: true,
  notes: true,
  balance: true,
  lastActivityAt: true,
  createdAt: true,
  assignedTo: { select: { id: true, fullName: true } },
} satisfies Prisma.CustomerSelect;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerSelect }>;

const inactiveCutoff = () => new Date(Date.now() - INACTIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);

/**
 * The shape sent to the frontend. Money is a string with 2 decimals ("8200.00")
 * so no precision is lost in JavaScript numbers.
 */
function toDto(row: CustomerRow, cutoff = inactiveCutoff()) {
  // "overdue" will come from invoices past their due date, once invoices exist.
  const status: CustomerStatus = row.lastActivityAt < cutoff ? "inactive" : "active";
  return { ...row, balance: row.balance.toFixed(2), status };
}

export type CustomerDto = ReturnType<typeof toDto>;

function statusWhere(status: CustomerStatus): Prisma.CustomerWhereInput {
  switch (status) {
    case "active":
      return { lastActivityAt: { gte: inactiveCutoff() } };
    case "inactive":
      return { lastActivityAt: { lt: inactiveCutoff() } };
    case "overdue":
      // Nothing can be overdue before invoices exist.
      return { id: { in: [] } };
  }
}

/** Filters shared by the list and the export. Always scoped to one company. */
function buildWhere(companyId: string, query: Omit<ListCustomersQuery, "page" | "pageSize" | "sort">) {
  const and: Prisma.CustomerWhereInput[] = [{ companyId }];

  if (query.status !== "all") and.push(statusWhere(query.status));
  if (query.assignedTo) and.push({ assignedToId: query.assignedTo === "none" ? null : query.assignedTo });
  if (query.balance === "due") and.push({ balance: { gt: 0 } });
  if (query.balance === "zero") and.push({ balance: { equals: 0 } });
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" } as const;
    and.push({
      OR: [{ name: contains }, { contactName: contains }, { phone: contains }, { email: contains }],
    });
  }

  return { AND: and } satisfies Prisma.CustomerWhereInput;
}

const ORDER_BY: Record<ListCustomersQuery["sort"], Prisma.CustomerOrderByWithRelationInput[]> = {
  recent: [{ lastActivityAt: "desc" }, { id: "asc" }],
  oldest: [{ lastActivityAt: "asc" }, { id: "asc" }],
  balance: [{ balance: "desc" }, { name: "asc" }, { id: "asc" }],
  name: [{ name: "asc" }, { id: "asc" }],
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listCustomers(companyId: string, query: ListCustomersQuery) {
  const where = buildWhere(companyId, query);
  const cutoff = inactiveCutoff();

  const [rows, total, all, active, inactive] = await prisma.$transaction([
    prisma.customer.findMany({
      where,
      select: customerSelect,
      orderBy: ORDER_BY[query.sort],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.customer.count({ where }),
    // Tab counts: the whole company, regardless of the other filters.
    prisma.customer.count({ where: { companyId } }),
    prisma.customer.count({ where: { companyId, lastActivityAt: { gte: cutoff } } }),
    prisma.customer.count({ where: { companyId, lastActivityAt: { lt: cutoff } } }),
  ]);

  return {
    items: rows.map((row) => toDto(row, cutoff)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts: { all, active, inactive, overdue: 0 },
  };
}

/** Every customer matching the filters (no paging), for CSV export. */
export async function exportCustomers(companyId: string, query: ListCustomersQuery) {
  const rows = await prisma.customer.findMany({
    where: buildWhere(companyId, query),
    select: customerSelect,
    orderBy: ORDER_BY[query.sort],
    take: EXPORT_LIMIT,
  });
  const cutoff = inactiveCutoff();
  return rows.map((row) => toDto(row, cutoff));
}

export async function getCustomer(companyId: string, id: string) {
  const row = await prisma.customer.findFirst({ where: { id, companyId }, select: customerSelect });
  if (!row) throw notFound("Customer");
  return toDto(row);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** An assignee must be a member of the same company. */
async function assertAssignees(companyId: string, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return;
  const found = await prisma.user.count({ where: { id: { in: wanted }, companyId } });
  if (found !== wanted.length) {
    throw new AppError(400, "INVALID_ASSIGNEE", "The assigned person is not a member of this company");
  }
}

export async function createCustomer(companyId: string, input: CreateCustomerInput) {
  await assertAssignees(companyId, [input.assignedToId]);
  const row = await prisma.customer.create({
    data: { ...withoutUndefined(input), name: input.name, companyId },
    select: customerSelect,
  });
  return toDto(row);
}

export async function updateCustomer(companyId: string, id: string, input: UpdateCustomerInput) {
  await assertAssignees(companyId, [input.assignedToId]);
  // updateMany so the company check and the update are one statement.
  const { count } = await prisma.customer.updateMany({
    where: { id, companyId },
    data: { ...withoutUndefined(input), lastActivityAt: new Date() },
  });
  if (count === 0) throw notFound("Customer");
  return getCustomer(companyId, id);
}

export async function deleteCustomer(companyId: string, id: string) {
  // When invoices exist, deleting a customer that has invoices will be refused.
  const { count } = await prisma.customer.deleteMany({ where: { id, companyId } });
  if (count === 0) throw notFound("Customer");
}

/** Ids from another company are silently skipped; the count says how many were deleted. */
export async function bulkDeleteCustomers(companyId: string, ids: string[]) {
  const { count } = await prisma.customer.deleteMany({ where: { id: { in: ids }, companyId } });
  return { deleted: count };
}

export async function bulkAssignCustomers(companyId: string, ids: string[], assignedToId: string | null) {
  await assertAssignees(companyId, [assignedToId]);
  const { count } = await prisma.customer.updateMany({
    where: { id: { in: ids }, companyId },
    data: { assignedToId },
  });
  return { updated: count };
}

/**
 * Creates many customers at once (CSV import). All or nothing: if any row is
 * invalid, nothing is saved and the error lists every bad row by number.
 */
export async function importCustomers(companyId: string, rows: unknown[]) {
  const valid: CreateCustomerInput[] = [];
  const rowErrors: { row: number; fieldErrors: Record<string, string[] | undefined> }[] = [];

  rows.forEach((raw, index) => {
    const result = createCustomerSchema.safeParse(raw);
    if (result.success) valid.push(result.data);
    else rowErrors.push({ row: index + 1, fieldErrors: z.flattenError(result.error).fieldErrors });
  });

  if (rowErrors.length > 0) {
    throw new AppError(400, "IMPORT_INVALID_ROWS", "Some rows are invalid; nothing was imported", {
      rows: rowErrors.slice(0, 50),
      invalidCount: rowErrors.length,
    });
  }

  await assertAssignees(
    companyId,
    valid.map((row) => row.assignedToId),
  );
  const { count } = await prisma.customer.createMany({
    data: valid.map((row) => ({ ...withoutUndefined(row), name: row.name, companyId })),
  });
  return { created: count };
}
