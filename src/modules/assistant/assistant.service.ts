// The assistant's conversations in the database, the plan's monthly limit, and what
// the app shows of a conversation.
import type { BetaMessageParam, BetaTextBlockParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Prisma } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { businessToday } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { Permission } from "../../lib/permissions.js";
import { currentPlan } from "../billing/plans.js";
import { readOutcome, type ChangeOutcome, type Pending, type PendingChange } from "./assistant.agent.js";
import { contextPrompt } from "./assistant.prompt.js";

type Actor = { id: string; companyId: string; role: string; permissions: readonly Permission[] };

const json = (value: unknown) => value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// The monthly limit
// ---------------------------------------------------------------------------

const thisMonth = () => businessToday().slice(0, 7);

export async function usage(companyId: string) {
  const plan = await currentPlan(prisma, companyId);
  const row = await prisma.assistantUsage.findUnique({ where: { companyId_month: { companyId, month: thisMonth() } } });
  return { month: thisMonth(), used: row?.messages ?? 0, limit: plan.assistantMessages, plan: plan.id };
}

/** Before a new message: refuses past the plan's limit, else counts it. */
export async function countMessage(companyId: string) {
  const { used, limit, plan } = await usage(companyId);
  if (used >= limit) {
    throw new AppError(402, "PLAN_LIMIT_ASSISTANT", "This plan's assistant messages for the month are used up", { plan, limit });
  }
  await prisma.assistantUsage.upsert({
    where: { companyId_month: { companyId, month: thisMonth() } },
    create: { companyId, month: thisMonth(), messages: 1 },
    update: { messages: { increment: 1 } },
  });
}

export async function addTokens(
  companyId: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
) {
  await prisma.assistantUsage.upsert({
    where: { companyId_month: { companyId, month: thisMonth() } },
    create: { companyId, month: thisMonth(), ...tokens },
    update: {
      inputTokens: { increment: tokens.inputTokens },
      outputTokens: { increment: tokens.outputTokens },
      cacheReadTokens: { increment: tokens.cacheReadTokens },
      cacheWriteTokens: { increment: tokens.cacheWriteTokens },
    },
  });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type StoredConversation = {
  id: string;
  title: string;
  messages: BetaMessageParam[];
  pending: Pending | null;
};

const notFound = () => new AppError(404, "NOT_FOUND", "Conversation not found");

/** Only the user's own conversations, in their company. */
export async function getConversation(actor: Actor, id: string): Promise<StoredConversation> {
  const row = await prisma.assistantConversation.findFirst({
    where: { id, userId: actor.id, companyId: actor.companyId },
    select: { id: true, title: true, messages: true, pending: true },
  });
  if (!row) throw notFound();
  return {
    id: row.id,
    title: row.title,
    messages: row.messages as unknown as BetaMessageParam[],
    pending: (row.pending as unknown as Pending | null) ?? null,
  };
}

export async function createConversation(actor: Actor, firstMessage: string) {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  const row = await prisma.assistantConversation.create({
    data: { title, companyId: actor.companyId, userId: actor.id },
    select: { id: true, title: true },
  });
  return { ...row, messages: [] as BetaMessageParam[], pending: null };
}

export async function listConversations(actor: Actor) {
  return prisma.assistantConversation.findMany({
    where: { userId: actor.id, companyId: actor.companyId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, updatedAt: true },
  });
}

export async function deleteConversation(actor: Actor, id: string) {
  const { count } = await prisma.assistantConversation.deleteMany({ where: { id, userId: actor.id, companyId: actor.companyId } });
  if (count === 0) throw notFound();
}

export async function saveConversation(id: string, messages: BetaMessageParam[], pending: Pending | null) {
  await prisma.assistantConversation.update({
    where: { id },
    data: { messages: json(messages), pending: pending ? json(pending) : json(null) },
  });
}

/** A turn at a time per conversation (a double click, two tabs). Stale after 5 minutes (a crash). */
export async function lockConversation(id: string) {
  const now = new Date();
  const { count } = await prisma.assistantConversation.updateMany({
    where: { id, OR: [{ busySince: null }, { busySince: { lt: new Date(now.getTime() - 5 * 60_000) } }] },
    data: { busySince: now },
  });
  if (count === 0) throw new AppError(409, "ASSISTANT_BUSY", "The assistant is still answering in this conversation");
}

export async function unlockConversation(id: string) {
  await prisma.assistantConversation.updateMany({ where: { id }, data: { busySince: null } });
}

// ---------------------------------------------------------------------------
// The prompt's second block: who is asking
// ---------------------------------------------------------------------------

export async function promptContext(actor: Actor) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: {
      fullName: true,
      customRole: { select: { name: true } },
      company: { select: { name: true, currency: true, vatEnabled: true, vatRate: true } },
    },
  });
  return contextPrompt({
    today: businessToday(),
    company: {
      name: user.company.name,
      currency: user.company.currency,
      vatEnabled: user.company.vatEnabled,
      vatRate: user.company.vatRate.toString(),
    },
    user: {
      name: user.fullName,
      role: actor.role === "custom" && user.customRole ? `custom role "${user.customRole.name}"` : actor.role,
      permissions: actor.permissions,
    },
  });
}

// ---------------------------------------------------------------------------
// A user's message as stored: the page they had open, then what they wrote
// ---------------------------------------------------------------------------

const PAGE_PREFIX = "[The user is on this page of the app: ";

export function userContent(text: string, page?: string): BetaTextBlockParam[] {
  return page ? [{ type: "text", text: `${PAGE_PREFIX}${page}]` }, { type: "text", text }] : [{ type: "text", text }];
}

// ---------------------------------------------------------------------------
// What the app shows
// ---------------------------------------------------------------------------

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "action";
      id: string;
      title: string;
      details: string[];
      method: string;
      path: string;
      status: ChangeOutcome["status"] | "pending";
      message?: string;
    };

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };

const blocks = (content: BetaMessageParam["content"] | undefined) =>
  (typeof content === "string" ? [{ type: "text", text: content }] : (content ?? [])) as Block[];

function failedMessage(outcome: Extract<ChangeOutcome, { status: "failed" }>) {
  const error = (outcome.error as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : `HTTP ${outcome.httpStatus}`;
}

/** The conversation as chat bubbles and action cards (tool calls for reading are left out). */
export function toDisplay(messages: BetaMessageParam[], pending: Pending | null): DisplayItem[] {
  const outcomes = new Map<string, ChangeOutcome>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of blocks(message.content)) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const outcome = readOutcome(block.content);
      if (outcome) outcomes.set(block.tool_use_id, outcome);
    }
  }
  const waiting = new Set(pending?.changes.map((change) => change.id) ?? []);

  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    for (const block of blocks(message.content)) {
      if (block.type === "text" && block.text) {
        if (message.role === "user" && block.text.startsWith(PAGE_PREFIX)) continue;
        const last = items.at(-1);
        // One bubble for the assistant's text between two things the user sees.
        if (message.role === "assistant" && last?.kind === "assistant") last.text += `\n\n${block.text}`;
        else items.push({ kind: message.role, text: block.text });
      } else if (block.type === "tool_use" && block.name === "mizan_change" && block.id) {
        const input = (block.input ?? {}) as Partial<PendingChange>;
        const outcome = outcomes.get(block.id);
        items.push({
          kind: "action",
          id: block.id,
          title: String(input.title ?? ""),
          details: Array.isArray(input.details) ? input.details.map(String) : [],
          method: String(input.method ?? ""),
          path: String(input.path ?? ""),
          status: outcome?.status ?? (waiting.has(block.id) ? "pending" : "failed"),
          ...(outcome?.status === "failed" ? { message: failedMessage(outcome) } : {}),
        });
      }
    }
  }
  return items;
}

/** The tool results for a pending turn the user moved on from (wrote something else instead). */
export function declinedResults(pending: Pending): BetaToolResultBlockParam[] {
  return [
    ...pending.results,
    ...pending.changes.map(
      (change): BetaToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: change.id,
        content: JSON.stringify({ status: "declined", note: "The user wrote a new message instead of confirming." }),
      }),
    ),
  ];
}

export const assistantModel = () => config.ASSISTANT_MODEL;
