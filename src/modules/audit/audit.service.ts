import type { AuditAction, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { currentRequest } from "../../lib/request-context.js";
import type { ListAuditQuery } from "./audit.schemas.js";

type Db = Prisma.TransactionClient;

export type AuditItem = { type: string; id?: string | null; ref?: string | null };
export type AuditInput = {
  action: AuditAction;
  /** What happened (AuditLog.events.<event> in the app). */
  event: string;
  item: AuditItem;
  /** Details for the text: amount, name, role, fields... (undefined values are left out). */
  values?: Record<string, unknown>;
};
/** Who did it. Left out: whoever is signed in on this request, or the system outside one. */
export type Who = { id: string | null; name: string | null };

/**
 * Records one line of the audit log. Call it inside the transaction that makes
 * the change, so the line exists exactly when the change does.
 */
export async function audit(db: Db, companyId: string, input: AuditInput, who?: Who) {
  const request = currentRequest();
  const actor = who ?? (request?.user ? { id: request.user.id, name: request.user.name } : { id: null, name: null });
  // The system (e.g. a recurring invoice made while a template is saved) has no IP of its own.
  const system = actor.id === null && actor.name === null;
  await db.auditEvent.create({
    data: {
      companyId,
      action: input.action,
      event: input.event,
      itemType: input.item.type,
      itemId: input.item.id ?? null,
      itemRef: input.item.ref ?? null,
      values: JSON.parse(JSON.stringify(input.values ?? {})) as Prisma.InputJsonValue,
      ip: system ? null : (request?.ip ?? null),
      userId: actor.id,
      userName: actor.name,
    },
  });
}

/** The fields an update changed (for "customer updated: phone, city"). */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || String(a ?? "") === String(b ?? "");
  return Object.keys(after).filter((k) => after[k] !== undefined && !same(before[k], after[k]));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const PERIOD_DAYS = { d7: 7, d30: 30, d90: 90 } as const;
const EXPORT_LIMIT = 5000;

function filterWhere(companyId: string, query: Omit<ListAuditQuery, "page" | "pageSize">): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [{ companyId }];
  if (query.userId === "system") and.push({ userId: null });
  else if (query.userId) and.push({ userId: query.userId });
  if (query.action !== "all") and.push({ action: query.action });
  if (query.period !== "all") {
    and.push({ createdAt: { gte: new Date(Date.now() - PERIOD_DAYS[query.period] * 86_400_000) } });
  }
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" } as const;
    and.push({ OR: [{ itemRef: contains }, { userName: contains }, { ip: contains }] });
  }
  return { AND: and };
}

const select = {
  id: true,
  createdAt: true,
  action: true,
  event: true,
  itemType: true,
  itemId: true,
  itemRef: true,
  values: true,
  ip: true,
  userId: true,
  userName: true,
} satisfies Prisma.AuditEventSelect;

type Row = Prisma.AuditEventGetPayload<{ select: typeof select }>;

const toDto = (r: Row) => ({
  id: r.id,
  at: r.createdAt.toISOString(),
  action: r.action,
  event: r.event,
  item: { type: r.itemType, id: r.itemId, ref: r.itemRef },
  values: r.values as Record<string, unknown>,
  ip: r.ip,
  user: r.userId || r.userName ? { id: r.userId, name: r.userName } : null,
});

const ORDER: Prisma.AuditEventOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

export async function listAudit(companyId: string, query: ListAuditQuery) {
  const where = filterWhere(companyId, query);
  const [rows, total, users] = await prisma.$transaction([
    prisma.auditEvent.findMany({
      where,
      select,
      orderBy: ORDER,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditEvent.count({ where }),
    // Everyone in the company, for the "user" filter.
    prisma.user.findMany({ where: { companyId }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
  ]);
  return {
    items: rows.map(toDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
    users: users.map((u) => ({ id: u.id, name: u.fullName })),
  };
}

/** The same filters, every line (up to 5000), for the CSV. */
export async function exportAudit(companyId: string, query: Omit<ListAuditQuery, "page" | "pageSize">) {
  const rows = await prisma.auditEvent.findMany({
    where: filterWhere(companyId, query),
    select,
    orderBy: ORDER,
    take: EXPORT_LIMIT,
  });
  return { items: rows.map(toDto), limited: rows.length === EXPORT_LIMIT };
}
