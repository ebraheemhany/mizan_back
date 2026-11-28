// /api/assistant: the assistant (a free AI model) for every signed-in user. It acts as that
// user: it can read and change only what they could in the app, and every change
// waits for their confirmation. Answers stream as server-sent events.
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { parseId } from "../../lib/params.js";
import { authenticate } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { assistantEnabled, closeDanglingCalls, runChanges, runTurn, type AssistantEvent } from "./assistant.agent.js";
import { ModelUnavailableError, type ChatMessage } from "./assistant.llm.js";
import { reportError } from "../../lib/error-alerts.js";
import { staticPrompt } from "./assistant.prompt.js";
import {
  addTokens,
  countMessage,
  createConversation,
  declinedResults,
  deleteConversation,
  getConversation,
  listConversations,
  lockConversation,
  promptContext,
  saveConversation,
  toDisplay,
  unlockConversation,
  usage,
  userMessage,
  type StoredConversation,
} from "./assistant.service.js";

const messageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  /** The app page the user has open (/invoices/1044), so "this invoice" means something. */
  page: z.string().trim().max(200).optional(),
});

const decisionSchema = z.object({ approve: z.boolean() });

/** About 25K tokens of conversation: free plans count every token of it on every request. */
export const MAX_CONVERSATION_CHARS = 90_000;

const requireEnabled: RequestHandler = (_req, _res, next) => {
  if (!assistantEnabled()) throw new AppError(503, "ASSISTANT_OFF", "The assistant isn't set up on this server");
  next();
};

/** The confirmation card's fields (the body stays on the server). */
const cards = (conversation: StoredConversation) =>
  conversation.pending?.changes.map(({ body: _body, ...card }) => card) ?? null;

/** Opens the event stream; pings keep proxies from closing a quiet connection. */
function openStream(res: Response) {
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const open = () => !res.writableEnded && !res.destroyed;
  const ping = setInterval(() => open() && res.write(": ping\n\n"), 15_000);
  return {
    send(event: AssistantEvent | { type: string; [key: string]: unknown }) {
      if (open()) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(ping);
      if (open()) res.end();
    },
  };
}

function errorEvent(err: unknown) {
  if (err instanceof AppError) return { type: "error", code: err.code, message: err.message };
  // Only the assistant stops; the rest of the app is unaffected.
  if (err instanceof ModelUnavailableError) {
    if (err.reason === "limit") return { type: "error", code: "ASSISTANT_QUOTA", message: "The free AI quota is used up for now, try again later" };
    if (err.reason === "auth") return { type: "error", code: "ASSISTANT_SUSPENDED", message: "The assistant is paused for now" };
    return { type: "error", code: "ASSISTANT_UNAVAILABLE", message: "The assistant is busy right now, try again in a moment" };
  }
  return { type: "error", code: "ASSISTANT_FAILED", message: "The assistant couldn't finish this answer" };
}

/**
 * Runs a turn on a locked conversation and streams it. `start` gives the messages to
 * send (the user's new message, or the results of the changes they confirmed).
 */
async function streamTurn(
  req: Request,
  res: Response,
  conversation: StoredConversation,
  start: (emit: (event: AssistantEvent) => void) => Promise<ChatMessage[]>,
) {
  const actor = req.user!;
  const stream = openStream(res);
  stream.send({ type: "conversation", id: conversation.id, title: conversation.title });

  const emit = (event: AssistantEvent) => {
    if (event.type === "usage") {
      const { type: _type, ...tokens } = event;
      addTokens(actor.companyId, tokens).catch((err: unknown) => req.log.error({ err }, "assistant usage not saved"));
      return;
    }
    stream.send(event);
  };

  try {
    const messages = await start(emit);
    await saveConversation(conversation.id, messages, null);
    await runTurn(messages, {
      system: { fixed: staticPrompt(), context: await promptContext(actor) },
      caller: { token: req.headers.authorization!.slice("Bearer ".length).trim(), ip: req.ip ?? null },
      emit,
      save: (next, pending) => saveConversation(conversation.id, next, pending),
    });
  } catch (err) {
    const event = errorEvent(err);
    req.log.error(
      { err },
      event.code === "ASSISTANT_SUSPENDED"
        ? "assistant turn failed: every model provider refused its key (check GROQ_API_KEY / LLM_API_KEY)"
        : "assistant turn failed",
    );
    stream.send(event);
    // Mizan's staff hear of it (keys refused, the free quota used up, a bug), not only the user.
    if (!(err instanceof AppError)) {
      void reportError(err, { where: `assistant (${event.code})`, userId: actor.id, companyId: actor.companyId });
    }
  } finally {
    await unlockConversation(conversation.id).catch(() => undefined);
    stream.send({ type: "done", usage: await usage(actor.companyId).catch(() => null) });
    stream.end();
  }
}

export function createAssistantRouter() {
  const router = Router();
  router.use(authenticate);

  const id = (req: Request) => parseId(req.params["id"], "Conversation");

  /** Whether the assistant is on, and the month's messages used of the plan's. */
  router.get("/status", async (req, res) => {
    res.json({ enabled: assistantEnabled(), usage: await usage(req.user!.companyId) });
  });

  router.get("/conversations", async (req, res) => {
    res.json({ conversations: await listConversations(req.user!) });
  });

  router.get("/conversations/:id", async (req, res) => {
    const conversation = await getConversation(req.user!, id(req));
    res.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        items: toDisplay(conversation.messages, conversation.pending),
        pending: cards(conversation),
      },
    });
  });

  router.delete("/conversations/:id", async (req, res) => {
    await deleteConversation(req.user!, id(req));
    res.status(204).end();
  });

  /** A new conversation with its first message. */
  router.post("/conversations", requireEnabled, validateBody(messageSchema), async (req, res) => {
    const { text, page } = req.body as z.infer<typeof messageSchema>;
    await countMessage(req.user!.companyId);
    const conversation = await createConversation(req.user!, text);
    await lockConversation(conversation.id);
    await streamTurn(req, res, conversation, async () => [userMessage(text, page)]);
  });

  /** The next message. If changes were waiting for confirmation, writing instead declines them. */
  router.post("/conversations/:id/messages", requireEnabled, validateBody(messageSchema), async (req, res) => {
    const { text, page } = req.body as z.infer<typeof messageSchema>;
    const conversation = await getConversation(req.user!, id(req));
    // A very long conversation costs more on every message (and past ~100K tokens, at a
    // higher rate): the user starts a new one instead.
    if (JSON.stringify(conversation.messages).length > MAX_CONVERSATION_CHARS) {
      throw new AppError(409, "ASSISTANT_CONVERSATION_FULL", "This conversation is too long: start a new one");
    }
    await lockConversation(conversation.id);
    try {
      await countMessage(req.user!.companyId);
    } catch (err) {
      await unlockConversation(conversation.id);
      throw err;
    }
    await streamTurn(req, res, conversation, async () => {
      // The tool results first (all of the last turn's calls are answered), then what they wrote.
      if (conversation.pending) return [...conversation.messages, ...declinedResults(conversation.pending), userMessage(text, page)];
      return [...closeDanglingCalls(conversation.messages), userMessage(text, page)];
    });
  });

  /** The user confirmed (or cancelled) the changes on the card; the assistant then carries on. */
  router.post("/conversations/:id/decision", requireEnabled, validateBody(decisionSchema), async (req, res) => {
    const { approve } = req.body as z.infer<typeof decisionSchema>;
    const conversationId = id(req);
    await lockConversation((await getConversation(req.user!, conversationId)).id);
    // Read again under the lock: a second click must not run the changes twice.
    const conversation = await getConversation(req.user!, conversationId);
    const pending = conversation.pending;
    if (!pending) {
      await unlockConversation(conversation.id);
      throw new AppError(409, "NOTHING_TO_CONFIRM", "There is nothing waiting for confirmation");
    }
    await streamTurn(req, res, conversation, async (emit) => {
      const caller = { token: req.headers.authorization!.slice("Bearer ".length).trim(), ip: req.ip ?? null };
      const results = await runChanges(pending, approve, { caller, emit });
      const messages: ChatMessage[] = [...conversation.messages, ...results];
      // Saved at once: what was done is recorded even if the rest of the turn fails.
      await saveConversation(conversation.id, messages, null);
      return messages;
    });
  });

  return router;
}
