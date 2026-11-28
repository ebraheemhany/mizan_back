import { Prisma, type Role } from "../../generated/prisma/client.js";
import { addDays, businessToday, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { withoutUndefined } from "../../lib/object.js";
import { notFound } from "../../lib/params.js";
import { can, type Permission } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import type { CreateTaskInput, UpdateTaskInput } from "./tasks.schemas.js";

type Actor = { id: string; companyId: string; role: Role; permissions: readonly Permission[] };

/** Done tasks stay in the list for this many days after the day they were done. */
export const DONE_VISIBLE_DAYS = 60;
/** The most tasks the list returns (open ones first). */
export const LIST_LIMIT = 1000;

const taskSelect = {
  id: true,
  title: true,
  dueDate: true,
  priority: true,
  kind: true,
  completedOn: true,
  createdAt: true,
  // The live customer, so a renamed customer shows its new name.
  customer: { select: { id: true, name: true } },
  deal: { select: { id: true, title: true } },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

function toDto(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    due: toIso(row.dueDate),
    priority: row.priority,
    kind: row.kind,
    done: row.completedOn !== null,
    completedOn: row.completedOn ? toIso(row.completedOn) : null,
    customer: row.customer,
    deal: row.deal,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export type TaskDto = ReturnType<typeof toDto>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every open task (whatever its due date), soonest due first, then the tasks
 * done in the last DONE_VISIBLE_DAYS days, most recently done first.
 */
export async function listTasks(companyId: string) {
  const today = businessToday();
  const [open, done] = await prisma.$transaction([
    prisma.task.findMany({
      where: { companyId, completedOn: null },
      select: taskSelect,
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: LIST_LIMIT,
    }),
    prisma.task.findMany({
      where: { companyId, completedOn: { gte: toDate(addDays(today, -DONE_VISIBLE_DAYS)) } },
      select: taskSelect,
      orderBy: [{ completedOn: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
    }),
  ]);
  return { today, items: [...open, ...done].slice(0, LIST_LIMIT).map(toDto) };
}

async function getTask(companyId: string, id: string) {
  const row = await prisma.task.findFirst({ where: { id, companyId }, select: taskSelect });
  if (!row) throw notFound("Task");
  return toDto(row);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const invalidCustomer = () =>
  new AppError(400, "INVALID_CUSTOMER", "Choose a customer of this company", { field: "customerId" });

/** A linked customer must belong to the same company. */
async function assertCustomer(companyId: string, customerId: string | null | undefined) {
  if (!customerId) return;
  const found = await prisma.customer.count({ where: { id: customerId, companyId } });
  if (found === 0) throw invalidCustomer();
}

const invalidDeal = () => new AppError(400, "INVALID_DEAL", "Choose a deal of this company", { field: "dealId" });

/** A linked deal must belong to the same company; returns its customer (to fill in a missing one). */
async function assertDeal(companyId: string, dealId: string | null | undefined) {
  if (!dealId) return null;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, companyId }, select: { customerId: true } });
  if (!deal) throw invalidDeal();
  return deal;
}

/**
 * The database refused the customer link: the customer was deleted between the check
 * above and the write. Same answer as if it had never been there.
 */
const rethrowCustomerGone = (err: unknown): never => {
  throw err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003" ? invalidCustomer() : err;
};

export async function createTask(actor: Actor, input: CreateTaskInput) {
  await assertCustomer(actor.companyId, input.customerId);
  const deal = await assertDeal(actor.companyId, input.dealId);
  const row = await prisma.task
    .create({
      data: {
        title: input.title,
        dueDate: toDate(input.due),
        priority: input.priority,
        kind: input.kind,
        // A task about a deal is about its customer too, unless another one was chosen.
        customerId: input.customerId ?? deal?.customerId ?? null,
        dealId: input.dealId ?? null,
        companyId: actor.companyId,
        createdById: actor.id,
      },
      select: taskSelect,
    })
    .catch(rethrowCustomerGone);
  return toDto(row);
}

/**
 * done: true records today (Cairo) as the day it was done, or `completedOn` when given
 * (undoing a reopen); a task that is already done keeps its original day unless
 * `completedOn` is given. done: false reopens it.
 */
function completion(done: boolean | undefined, wasDone: boolean, completedOn: string | undefined) {
  if (done === false) return { completedOn: null, completedAt: null };
  if (done === true && completedOn !== undefined) return { completedOn: toDate(completedOn), completedAt: new Date() };
  if (done === true && !wasDone) return { completedOn: toDate(businessToday()), completedAt: new Date() };
  return {};
}

export async function updateTask(actor: Actor, id: string, input: UpdateTaskInput) {
  if (input.completedOn !== undefined && input.completedOn > businessToday()) {
    throw new AppError(400, "VALIDATION_ERROR", "A task can't be done on a day after today", {
      fieldErrors: { completedOn: ["Not after today"] },
    });
  }
  const existing = await prisma.task.findFirst({
    where: { id, companyId: actor.companyId },
    select: { completedOn: true },
  });
  if (!existing) throw notFound("Task");
  await assertCustomer(actor.companyId, input.customerId);
  const deal = await assertDeal(actor.companyId, input.dealId);

  const data = {
    ...withoutUndefined({
      title: input.title,
      dueDate: input.due === undefined ? undefined : toDate(input.due),
      priority: input.priority,
      kind: input.kind,
      // Linking a deal without naming a customer: the deal's customer.
      customerId: input.customerId === undefined && deal ? deal.customerId : input.customerId,
      dealId: input.dealId,
    }),
    ...completion(input.done, existing.completedOn !== null, input.completedOn),
  } satisfies Prisma.TaskUncheckedUpdateManyInput;

  // Nothing to write when the only change was "done" on a task that is already done.
  if (Object.keys(data).length > 0) {
    // updateMany so the company check and the update are one statement.
    const { count } = await prisma.task
      .updateMany({ where: { id, companyId: actor.companyId }, data })
      .catch(rethrowCustomerGone);
    if (count === 0) throw notFound("Task");
  }
  return getTask(actor.companyId, id);
}

/** The owner can delete any task; everyone else only the tasks they added. */
export async function deleteTask(actor: Actor, id: string) {
  const row = await prisma.task.findFirst({
    where: { id, companyId: actor.companyId },
    select: { id: true, createdById: true },
  });
  if (!row) throw notFound("Task");

  if (!can(actor, "deleteData") && row.createdById !== actor.id) {
    throw new AppError(403, "FORBIDDEN", "Only the owner or the person who added a task can delete it");
  }
  // deleteMany + count: a delete that lost a race with another one is a 404, not a 500.
  const { count } = await prisma.task.deleteMany({ where: { id: row.id, companyId: actor.companyId } });
  if (count === 0) throw notFound("Task");
}
