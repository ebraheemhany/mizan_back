import type { DealStage, Prisma, Role } from "../../generated/prisma/client.js";
import { addDays, businessToday, daysBetween, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { money, moneyString } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { can } from "../../lib/permissions.js";
import { prisma } from "../../lib/prisma.js";
import { audit, changedFields } from "../audit/audit.service.js";
import type { CreateDealInput, DealStageValue, LoseDealInput, UpdateDealInput } from "./deals.schemas.js";

type Actor = { id: string; companyId: string; role: Role };
type Tx = Prisma.TransactionClient;

/** Days without any activity before an open deal is flagged on the board. */
export const STALE_DAYS = 5;
/** Won and lost deals stay on the board (and in its numbers) for this long. */
const CLOSED_DAYS = 90;

const dealSelect = {
  id: true,
  title: true,
  value: true,
  stage: true,
  closeDate: true,
  notes: true,
  lastActivityAt: true,
  awaitingReply: true,
  followUpDate: true,
  wonAt: true,
  lostOn: true,
  lostReason: true,
  lostNote: true,
  createdAt: true,
  customerId: true,
  customer: { select: { name: true } },
  ownerId: true,
  owner: { select: { fullName: true } },
  _count: { select: { tasks: { where: { completedOn: null } } } },
} satisfies Prisma.DealSelect;

type DealRow = Prisma.DealGetPayload<{ select: typeof dealSelect }>;

function toDto(row: DealRow, today: string) {
  return {
    id: row.id,
    title: row.title,
    value: moneyString(row.value),
    stage: row.stage,
    closeDate: toIso(row.closeDate),
    notes: row.notes,
    customerId: row.customerId,
    customer: row.customer.name,
    ownerId: row.ownerId,
    owner: row.owner?.fullName ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    // Whole days in Egypt since the last activity.
    lastActivityDaysAgo: Math.max(0, daysBetween(businessToday(row.lastActivityAt), today)),
    awaitingReply: row.awaitingReply,
    followUpDate: row.followUpDate ? toIso(row.followUpDate) : null,
    wonAt: row.wonAt?.toISOString() ?? null,
    // Tasks about it that are still open.
    openTasks: row._count.tasks,
    lost: row.lostOn ? { reason: row.lostReason, note: row.lostNote, date: toIso(row.lostOn) } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type DealDto = ReturnType<typeof toDto>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The board: every open deal, and those won or lost in the last 90 days (older
 * ones have done their part in the numbers and would only crowd the board).
 */
export async function listDeals(companyId: string) {
  const today = businessToday();
  const since = toDate(addDays(today, -CLOSED_DAYS));
  const rows = await prisma.deal.findMany({
    where: {
      companyId,
      OR: [
        { lostOn: null, stage: { not: "won" } },
        { lostOn: null, stage: "won", closeDate: { gte: since } },
        { lostOn: { gte: since } },
      ],
    },
    select: dealSelect,
    orderBy: [{ lastActivityAt: "desc" }, { id: "asc" }],
  });
  return { today, staleDays: STALE_DAYS, deals: rows.map((r) => toDto(r, today)) };
}

async function findDeal(db: Tx, companyId: string, id: string) {
  const row = await db.deal.findFirst({ where: { id, companyId }, select: dealSelect });
  if (!row) throw notFound("Deal");
  return row;
}

export async function getDeal(companyId: string, id: string) {
  return toDto(await findDeal(prisma, companyId, id), businessToday());
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const invalidCustomer = () =>
  new AppError(400, "INVALID_CUSTOMER", "Choose a customer of this company", { field: "customerId" });
const invalidOwner = () =>
  new AppError(400, "INVALID_ASSIGNEE", "The responsible person is not a member of this company", { field: "ownerId" });
const dealLost = () => new AppError(409, "DEAL_LOST", "This deal was lost; reopen it first");
const dealChanged = () =>
  new AppError(409, "DEAL_CHANGED", "Someone changed this deal meanwhile; reload and try again");

async function assertRefs(companyId: string, customerId: string, ownerId: string | null | undefined) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
  if (!customer) throw invalidCustomer();
  if (ownerId) {
    const owner = await prisma.user.findFirst({ where: { id: ownerId, companyId }, select: { id: true } });
    if (!owner) throw invalidOwner();
  }
}

const dealRef = (row: { id: string; title: string }) => ({ type: "deal", id: row.id, ref: row.title });

export async function createDeal(actor: Actor, input: CreateDealInput) {
  await assertRefs(actor.companyId, input.customerId, input.ownerId);
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.deal.create({
      data: {
        title: input.title,
        value: money(input.value),
        stage: input.stage,
        closeDate: toDate(input.closeDate),
        notes: input.notes ?? null,
        followUpDate: input.followUpDate ? toDate(input.followUpDate) : null,
        awaitingReply: input.awaitingReply ?? false,
        companyId: actor.companyId,
        customerId: input.customerId,
        ownerId: input.ownerId ?? null,
        createdById: actor.id,
      },
      select: dealSelect,
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: "dealCreated",
      item: dealRef(created),
      values: { amount: moneyString(created.value), customer: created.customer.name, stage: created.stage },
    });
    return created;
  });
  return toDto(row, today);
}

/**
 * Edits the deal's details. Changing the stage here counts as activity (like
 * moving it on the board). A won deal keeps its stage; a lost one must be
 * reopened first.
 */
export async function updateDeal(actor: Actor, id: string, input: UpdateDealInput) {
  await assertRefs(actor.companyId, input.customerId, input.ownerId);
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const before = await findDeal(tx, actor.companyId, id);
    if (before.lostOn) throw dealLost();
    const won = before.stage === "won";
    const stage = won ? "won" : (input.stage ?? before.stage);
    const moved = stage !== before.stage;

    const data = {
      title: input.title,
      value: money(input.value),
      stage,
      closeDate: toDate(input.closeDate),
      notes: input.notes ?? null,
      followUpDate: input.followUpDate ? toDate(input.followUpDate) : null,
      customerId: input.customerId,
      ownerId: input.ownerId ?? null,
      awaitingReply: input.awaitingReply ?? (moved ? false : before.awaitingReply),
      ...(moved ? { lastActivityAt: new Date() } : {}),
    };
    // Only from the state that was read (a move or a loss meanwhile wins).
    const { count } = await tx.deal.updateMany({
      where: { id, companyId: actor.companyId, stage: before.stage, lostOn: null },
      data,
    });
    if (count === 0) throw dealChanged();

    const fields = changedFields(
      {
        title: before.title,
        value: moneyString(before.value),
        stage: before.stage,
        closeDate: toIso(before.closeDate),
        notes: before.notes,
        followUpDate: before.followUpDate ? toIso(before.followUpDate) : null,
        customerId: before.customerId,
        ownerId: before.ownerId,
        awaitingReply: before.awaitingReply,
      },
      {
        title: input.title,
        value: moneyString(money(input.value)),
        stage,
        closeDate: input.closeDate,
        notes: input.notes ?? null,
        followUpDate: input.followUpDate ?? null,
        customerId: input.customerId,
        ownerId: input.ownerId ?? null,
        awaitingReply: data.awaitingReply,
      },
    );
    const after = await findDeal(tx, actor.companyId, id);
    if (fields.length > 0) {
      await audit(tx, actor.companyId, {
        action: "update",
        event: "dealUpdated",
        item: dealRef(after),
        values: { fields, amount: moneyString(after.value), customer: after.customer.name },
      });
    }
    return after;
  });
  return toDto(row, today);
}

/**
 * Moves a deal to another stage (the board's drag and drop). Winning it sets its
 * close date to today; moving a won deal back (undo) reopens it. Either way it is
 * activity: the follow-up counter restarts and "awaiting reply" clears.
 */
export async function moveDeal(actor: Actor, id: string, stage: DealStageValue) {
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const before = await findDeal(tx, actor.companyId, id);
    if (before.lostOn) throw dealLost();
    if (before.stage === stage) return before;

    const { count } = await tx.deal.updateMany({
      where: { id, companyId: actor.companyId, stage: before.stage, lostOn: null },
      data: {
        stage,
        lastActivityAt: new Date(),
        awaitingReply: false,
        ...(stage === "won" ? { closeDate: toDate(today), wonAt: new Date(), followUpDate: null } : {}),
        ...(before.stage === "won" ? { wonAt: null } : {}),
      },
    });
    if (count === 0) throw dealChanged();
    const after = await findDeal(tx, actor.companyId, id);
    await audit(tx, actor.companyId, {
      action: "update",
      event: stage === "won" ? "dealWon" : "dealMoved",
      item: dealRef(after),
      values: { from: before.stage, stage, amount: moneyString(after.value), customer: after.customer.name },
    });
    return after;
  });
  return toDto(row, today);
}

/** An open deal is lost (a won one can't be). It keeps its stage, for the funnel and reopening. */
export async function loseDeal(actor: Actor, id: string, input: LoseDealInput) {
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const before = await findDeal(tx, actor.companyId, id);
    const { count } = await tx.deal.updateMany({
      where: { id, companyId: actor.companyId, lostOn: null, stage: { not: "won" } },
      data: {
        lostOn: toDate(today),
        lostReason: input.reason,
        lostNote: input.note ?? null,
        lastActivityAt: new Date(),
        awaitingReply: false,
        followUpDate: null,
      },
    });
    if (count === 0) throw new AppError(409, "DEAL_NOT_OPEN", "Only an open deal can be marked as lost");
    await audit(tx, actor.companyId, {
      action: "update",
      event: "dealLost",
      item: dealRef(before),
      values: { reason: input.reason, amount: moneyString(before.value), customer: before.customer.name },
    });
    return findDeal(tx, actor.companyId, id);
  });
  return toDto(row, today);
}

/** A lost deal goes back on the board, at the stage it was lost at. */
export async function reopenDeal(actor: Actor, id: string) {
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const before = await findDeal(tx, actor.companyId, id);
    const { count } = await tx.deal.updateMany({
      where: { id, companyId: actor.companyId, lostOn: { not: null } },
      data: { lostOn: null, lostReason: null, lostNote: null, lastActivityAt: new Date() },
    });
    if (count === 0) throw new AppError(409, "DEAL_NOT_LOST", "This deal isn't lost");
    await audit(tx, actor.companyId, {
      action: "update",
      event: "dealReopened",
      item: dealRef(before),
      values: { stage: before.stage, amount: moneyString(before.value), customer: before.customer.name },
    });
    return findDeal(tx, actor.companyId, id);
  });
  return toDto(row, today);
}

/** Someone followed up just now (a call, a message): the counter restarts. */
export async function touchDeal(actor: Actor, id: string, awaitingReply: boolean) {
  const today = businessToday();
  const row = await prisma.$transaction(async (tx) => {
    const before = await findDeal(tx, actor.companyId, id);
    const { count } = await tx.deal.updateMany({
      where: { id, companyId: actor.companyId, lostOn: null, stage: { not: "won" } },
      data: {
        lastActivityAt: new Date(),
        awaitingReply,
        // Today's follow-up is done.
        ...(before.followUpDate && toIso(before.followUpDate) <= today ? { followUpDate: null } : {}),
      },
    });
    if (count === 0) throw new AppError(409, "DEAL_NOT_OPEN", "Only an open deal can be followed up");
    await audit(tx, actor.companyId, {
      action: "update",
      event: awaitingReply ? "dealAwaiting" : "dealFollowedUp",
      item: dealRef(before),
      values: { customer: before.customer.name },
    });
    return findDeal(tx, actor.companyId, id);
  });
  return toDto(row, today);
}

/** Anyone who works on deals can delete one, except a won deal: that is the owner's call. */
export async function deleteDeal(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const row = await findDeal(tx, actor.companyId, id);
    if (row.stage === "won" && !row.lostOn && !can(actor.role, "deleteData")) {
      throw new AppError(403, "FORBIDDEN", "Only the owner can delete a won deal");
    }
    const { count } = await tx.deal.deleteMany({ where: { id, companyId: actor.companyId } });
    if (count === 0) throw notFound("Deal");
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "dealDeleted",
      item: { type: "deal", ref: row.title },
      values: { amount: moneyString(row.value), customer: row.customer.name, stage: row.stage },
    });
  });
}

export type { DealStage };
