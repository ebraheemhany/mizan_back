// The assistant's loop: send the conversation to Claude, run the reads it asks for,
// and stop before any change until the user confirms it in the app. The conversation
// is kept in the database (append only), so a confirmation can come minutes later in
// another request and the loop picks up where it stopped.
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { config } from "../../config.js";
import { findEndpoint, type HttpMethod } from "./assistant.catalog.js";
import { callMizan, type ApiResult, type Caller } from "./assistant.api.js";

// ---------------------------------------------------------------------------
// Talking to Claude
// ---------------------------------------------------------------------------

/** One request to Claude, streaming its text out as it comes. */
export type ModelCall = (params: BetaMessageStreamParams, onText: (delta: string) => void) => Promise<BetaMessage>;

let client: Anthropic | null = null;

const realModelCall: ModelCall = async (params, onText) => {
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream(params);
  stream.on("text", (delta) => onText(delta));
  return stream.finalMessage();
};

let modelOverride: ModelCall | null = null;

/** Tests script Claude's answers instead of calling it. */
export function setModelForTests(model: ModelCall | null) {
  modelOverride = model;
}

export const assistantEnabled = () => modelOverride !== null || Boolean(config.ANTHROPIC_API_KEY);

const model = (): ModelCall => modelOverride ?? realModelCall;

// ---------------------------------------------------------------------------
// The tools Claude gets
// ---------------------------------------------------------------------------

const PATH_HELP = "An endpoint path from the API reference with its :params filled in, e.g. /api/invoices/1044.";

const TOOLS: BetaToolUnion[] = [
  {
    name: "mizan_get",
    description:
      "Read the company's data from Mizan: a GET request to one endpoint of the API reference, as the signed-in user. " +
      "Runs at once and returns {status, data}. Use it as often as you need before answering.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: `${PATH_HELP} No query string here.` },
        query: {
          type: "object",
          description: 'Query string parameters, e.g. {"status": "overdue", "pageSize": 50}.',
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["path"],
    },
  },
  {
    name: "mizan_change",
    description:
      "Propose a change in Mizan (POST, PATCH, PUT or DELETE to one endpoint of the API reference). It is NOT done when you call it: " +
      "the user sees a confirmation card with your title and details and confirms or cancels. The result comes back as " +
      '{status: "done", data} once done, {status: "declined"} if the user cancelled, or {status: "failed", error}.',
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string", description: PATH_HELP },
        body: { type: "object", description: "The JSON body as the reference describes it. Leave it out when the endpoint takes none." },
        title: {
          type: "string",
          description: "What will happen, in one short line in the user's language (the card's title), e.g. «إصدار فاتورة لشركة النور بـ 11,400 ج.م».",
        },
        details: {
          type: "array",
          items: { type: "string" },
          description: "2 to 6 short lines with what the user should check: customer, items, amounts, dates, what is lost when deleting.",
        },
      },
      required: ["method", "path", "title"],
    },
  },
];

const queryValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

const getInput = z.object({
  path: z.string().min(5).max(300),
  query: z.record(z.string().max(50), queryValue).optional(),
});

const changeInput = z.object({
  method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
  path: z.string().min(5).max(300),
  body: z.record(z.string(), z.unknown()).optional(),
  title: z.string().trim().min(1).max(200),
  details: z.array(z.string().max(300)).max(12).optional(),
});

/** A query string written into the path (/api/invoices?status=paid) is moved to `query`. */
function splitPath(path: string, query: Record<string, unknown> = {}) {
  const at = path.indexOf("?");
  if (at < 0) return { path, query };
  const extra = Object.fromEntries(new URLSearchParams(path.slice(at + 1)));
  return { path: path.slice(0, at), query: { ...extra, ...query } };
}

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

/** A change Claude proposed, shown on the confirmation card. */
export type PendingChange = {
  id: string;
  method: Exclude<HttpMethod, "GET">;
  path: string;
  body?: Record<string, unknown> | undefined;
  title: string;
  details: string[];
};

/** Claude's last turn stopped on changes: the reads of that turn are already answered. */
export type Pending = { results: BetaToolResultBlockParam[]; changes: PendingChange[] };

/** What a change's tool result says (stored as JSON text in the conversation). */
export type ChangeOutcome =
  | { status: "done"; data: unknown }
  | { status: "declined"; note?: string }
  | { status: "failed"; httpStatus: number; error: unknown };

// ---------------------------------------------------------------------------
// Events streamed to the app while a turn runs
// ---------------------------------------------------------------------------

export type AssistantEvent =
  /** A request to Claude starts (text after it belongs to it). */
  | { type: "step" }
  | { type: "text"; delta: string }
  /** The text streamed since the last step is void (the step is being retried). */
  | { type: "retry" }
  | { type: "lookup"; path: string }
  | { type: "confirm"; actions: Omit<PendingChange, "body">[] }
  | { type: "action"; id: string; title: string; outcome: ChangeOutcome["status"]; message?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "error"; code: string; message: string };

export type Emit = (event: AssistantEvent) => void;

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Requests to Claude in one turn (each read is one). The last one must answer. */
const MAX_STEPS = 12;
/** A read's result is cut past this, so one big list can't flood the conversation. */
const MAX_RESULT_CHARS = 30_000;

export type TurnSetup = {
  /** The fixed prompt (cached for everyone) and who is asking (per user). */
  system: { fixed: string; context: string };
  caller: Caller;
  emit: Emit;
  /** Called after each change to the conversation, to save it. */
  save: (messages: BetaMessageParam[], pending: Pending | null) => Promise<void>;
};

export type TurnResult = { messages: BetaMessageParam[]; pending: Pending | null };

/**
 * Models that can hand a request they decline for policy reasons to a fallback model on
 * the server. Haiku can't (a list of fallbacks there is a 400): it just reports the refusal.
 */
const hasServerFallback = (model: string) =>
  model.startsWith("claude-opus-5") || model.startsWith("claude-fable-5") || model === "claude-sonnet-5-5";

function requestParams(messages: BetaMessageParam[], system: TurnSetup["system"], lastStep: boolean): BetaMessageStreamParams {
  const fixed: BetaTextBlockParam = { type: "text", text: system.fixed, cache_control: { type: "ephemeral" } };
  return {
    model: config.ASSISTANT_MODEL,
    max_tokens: 16_000,
    system: [fixed, { type: "text", text: system.context }],
    tools: TOOLS,
    // The last step must answer with what it has.
    ...(lastStep ? { tool_choice: { type: "none" } } : {}),
    messages,
    // Caches the conversation so far for the next step and the next message.
    cache_control: { type: "ephemeral" },
    output_config: { effort: config.ASSISTANT_EFFORT },
    // If the model declines for policy reasons, the API retries on its default fallback model.
    ...(hasServerFallback(config.ASSISTANT_MODEL)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {}),
  };
}

/**
 * What of Claude's answer goes back into the conversation. After a fallback (another
 * model finished the answer), the blocks before it are dropped except text, as the API asks.
 */
export function forHistory(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary < 0) return content;
  return content.filter((block, index) => index >= boundary || block.type === "text");
}

const toolResult = (id: string, content: string, isError = false): BetaToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});

function resultText(result: ApiResult) {
  const text = JSON.stringify({ status: result.status, data: result.data });
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the result is too long. Ask for less: filters, a smaller pageSize, one record.]`;
}

export const outcomeText = (outcome: ChangeOutcome) => {
  const text = JSON.stringify(outcome);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}…`;
};

/** A change's outcome, read back from its tool result (null if it isn't one). */
export function readOutcome(content: unknown): ChangeOutcome | null {
  if (typeof content !== "string" || !content.startsWith('{"status":"')) return null;
  try {
    const parsed = JSON.parse(content) as ChangeOutcome;
    return ["done", "declined", "failed"].includes(parsed.status) ? parsed : null;
  } catch {
    // Cut off (very long): it was done.
    return content.startsWith('{"status":"done"') ? { status: "done", data: null } : null;
  }
}

/** The API's own message for a failed call, for the card. */
function apiMessage(data: unknown) {
  const error = (data as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
}

async function runRead(block: BetaToolUseBlock, setup: TurnSetup): Promise<BetaToolResultBlockParam> {
  const parsed = getInput.safeParse(block.input);
  if (!parsed.success) {
    return toolResult(block.id, `Invalid input: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`, true);
  }
  const { path, query } = splitPath(parsed.data.path, parsed.data.query);
  if (!findEndpoint("GET", path)) {
    return toolResult(block.id, `GET ${path} is not an endpoint you can use. Use one from the API reference.`, true);
  }
  setup.emit({ type: "lookup", path });
  const result = await callMizan({ method: "GET", path, query: query as Record<string, string> }, setup.caller);
  return toolResult(block.id, resultText(result), !result.ok);
}

function proposeChange(block: BetaToolUseBlock): PendingChange | BetaToolResultBlockParam {
  const parsed = changeInput.safeParse(block.input);
  if (!parsed.success) {
    return toolResult(block.id, `Invalid input: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`, true);
  }
  const { method, title, details, body } = parsed.data;
  const { path, query } = splitPath(parsed.data.path);
  if (Object.keys(query).length > 0) {
    return toolResult(block.id, "Changes take no query string: put everything in the body.", true);
  }
  if (!findEndpoint(method, path)) {
    return toolResult(block.id, `${method} ${path} is not an endpoint you can use. Use one from the API reference.`, true);
  }
  return { id: block.id, method, path, body, title, details: details ?? [] };
}

/** Runs one change the user confirmed. */
export async function runChange(change: PendingChange, caller: Caller): Promise<ChangeOutcome> {
  const result = await callMizan({ method: change.method, path: change.path, body: change.body }, caller);
  return result.ok ? { status: "done", data: result.data } : { status: "failed", httpStatus: result.status, error: result.data };
}

export async function runChanges(pending: Pending, approve: boolean, setup: Pick<TurnSetup, "caller" | "emit">) {
  const results: BetaToolResultBlockParam[] = [...pending.results];
  for (const change of pending.changes) {
    const outcome: ChangeOutcome = approve ? await runChange(change, setup.caller) : { status: "declined" };
    setup.emit({
      type: "action",
      id: change.id,
      title: change.title,
      outcome: outcome.status,
      ...(outcome.status === "failed" ? { message: apiMessage(outcome.error) ?? `HTTP ${outcome.httpStatus}` } : {}),
    });
    results.push(toolResult(change.id, outcomeText(outcome)));
  }
  return results;
}

/**
 * Before a new turn: a turn that died after Claude asked for tools (a crash, a restart)
 * leaves tool calls with no results, which the API refuses. Answer them as interrupted.
 */
export function closeDanglingCalls(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string") return messages;
  const calls = last.content.filter((block) => block.type === "tool_use") as { id: string }[];
  if (calls.length === 0) return messages;
  return [
    ...messages,
    { role: "user", content: calls.map((call) => toolResult(call.id, "Interrupted before it ran; it did not happen.", true)) },
  ];
}

/**
 * Runs Claude until it answers or proposes changes. `messages` ends with the user's
 * message (or the results of the changes they confirmed).
 */
export async function runTurn(start: BetaMessageParam[], setup: TurnSetup): Promise<TurnResult> {
  let messages = start;
  for (let step = 0; step < MAX_STEPS; step++) {
    const params = requestParams(messages, setup.system, step === MAX_STEPS - 1);

    let message: BetaMessage | undefined;
    for (let attempt = 0; !message; attempt++) {
      try {
        setup.emit({ type: "step" });
        message = await model()(params, (delta) => setup.emit({ type: "text", delta }));
      } catch (err) {
        // A tool input that couldn't be parsed or a dropped connection: try the step again.
        // The API's own errors (overloaded, rate limited...) end the turn.
        if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
        setup.emit({ type: "retry" });
      }
    }

    setup.emit({
      type: "usage",
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    });

    if (message.stop_reason === "refusal") {
      // Nothing of a declined answer is kept (it may hold half a tool call).
      setup.emit({ type: "error", code: "ASSISTANT_REFUSED", message: "The assistant can't help with this request." });
      return { messages, pending: null };
    }

    const content = forHistory(message.content);
    if (content.length === 0) return { messages, pending: null };
    messages = [...messages, { role: "assistant", content }];

    const calls = content.filter((block): block is BetaToolUseBlock => block.type === "tool_use");
    if (calls.length === 0) {
      await setup.save(messages, null);
      return { messages, pending: null };
    }

    // A tool input cut off by max_tokens can look valid: never run it.
    if (message.stop_reason === "max_tokens") {
      const cut = calls.map((call) => toolResult(call.id, "Your answer was cut off before this call was complete; it did not run. Try again with less.", true));
      messages = [...messages, { role: "user", content: cut }];
      await setup.save(messages, null);
      continue;
    }

    const results: BetaToolResultBlockParam[] = [];
    const changes: PendingChange[] = [];
    for (const call of calls) {
      if (call.name === "mizan_get") {
        results.push(await runRead(call, setup));
      } else if (call.name === "mizan_change") {
        const proposal = proposeChange(call);
        if ("type" in proposal) results.push(proposal);
        else changes.push(proposal);
      } else {
        results.push(toolResult(call.id, `There is no tool named ${call.name}.`, true));
      }
    }

    if (changes.length > 0) {
      const pending: Pending = { results, changes };
      await setup.save(messages, pending);
      setup.emit({ type: "confirm", actions: changes.map(({ body: _body, ...card }) => card) });
      return { messages, pending };
    }

    messages = [...messages, { role: "user", content: results }];
    await setup.save(messages, null);
  }
  return { messages, pending: null };
}
