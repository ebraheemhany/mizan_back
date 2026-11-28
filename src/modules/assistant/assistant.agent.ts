// The assistant's loop: send the conversation to the model, run the reads it asks for,
// and stop before any change until the user confirms it in the app. The conversation
// is kept in the database (append only), so a confirmation can come minutes later in
// another request and the loop picks up where it stopped.
import { z } from "zod";
import { apiDocs, findEndpoint, SECTION_IDS, type HttpMethod } from "./assistant.catalog.js";
import { callMizan, type ApiResult, type Caller } from "./assistant.api.js";
import { callModel, type ChatMessage, type ModelReply, type ToolCall, type ToolDef } from "./assistant.llm.js";

export { assistantEnabled, setModelForTests } from "./assistant.llm.js";

// ---------------------------------------------------------------------------
// The tools the model gets
// ---------------------------------------------------------------------------

const PATH_HELP = "An endpoint path from the API list with its :params filled in, e.g. /api/invoices/1044.";

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "mizan_docs",
      description: "The query strings and bodies of API sections. Read them before calling a section's endpoints with a query or a body.",
      parameters: {
        type: "object",
        properties: { sections: { type: "array", items: { type: "string", enum: SECTION_IDS }, description: "Section ids, e.g. [\"invoices\"]." } },
        required: ["sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mizan_get",
      description: "Read the company's data: a GET to one endpoint of the API list, as the signed-in user. Runs at once; returns {status, data}.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: `${PATH_HELP} No query string here.` },
          query: { type: "object", description: 'Query parameters, e.g. {"status": "overdue", "pageSize": 20}.' },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mizan_change",
      description:
        "Propose a change (POST, PATCH, PUT or DELETE to one endpoint of the API list). NOT done when called: the user confirms or cancels a card. " +
        'The result comes back as {"status":"done","data":...}, {"status":"declined"} or {"status":"failed","error":...}.',
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
          path: { type: "string", description: PATH_HELP },
          body: { type: "object", description: "The JSON body from the section's docs. Leave out when the endpoint takes none." },
          title: { type: "string", description: "What will happen, one short line in the user's language (the card's title)." },
          details: { type: "array", items: { type: "string" }, description: "2-6 short lines the user should check: who, items, amounts, dates." },
        },
        required: ["method", "path", "title"],
      },
    },
  },
];

const queryValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

const docsInput = z.object({ sections: z.array(z.string()).min(1).max(14) });

const getInput = z.object({
  path: z.string().min(5).max(300),
  query: z.record(z.string().max(50), queryValue).nullish(),
});

const changeInput = z.object({
  method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
  path: z.string().min(5).max(300),
  body: z.record(z.string(), z.unknown()).nullish(),
  title: z.string().trim().min(1).max(200),
  details: z.array(z.string().max(300)).max(12).nullish(),
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

/** A change the model proposed, shown on the confirmation card. */
export type PendingChange = {
  id: string;
  method: Exclude<HttpMethod, "GET">;
  path: string;
  body?: Record<string, unknown> | undefined;
  title: string;
  details: string[];
};

type ToolResult = Extract<ChatMessage, { role: "tool" }>;

/** The model's last turn stopped on changes: the other calls of that turn are already answered. */
export type Pending = {
  results: ToolResult[];
  changes: PendingChange[];
  /** The calls in the order the model made them (some providers want the results in it). */
  order: string[];
};

/** The results of a turn's calls, in the order of the calls. */
export function inCallOrder(results: ToolResult[], order: readonly string[]) {
  const position = (r: ToolResult) => (order.includes(r.tool_call_id) ? order.indexOf(r.tool_call_id) : order.length);
  return [...results].sort((a, b) => position(a) - position(b));
}

/** What a change's result says (stored as JSON text in the conversation). */
export type ChangeOutcome =
  | { status: "done"; data: unknown }
  | { status: "declined"; note?: string }
  | { status: "failed"; httpStatus: number; error: unknown };

// ---------------------------------------------------------------------------
// Events streamed to the app while a turn runs
// ---------------------------------------------------------------------------

export type AssistantEvent =
  /** A request to the model starts (text after it belongs to it). */
  | { type: "step" }
  | { type: "text"; delta: string }
  /** The text streamed since the last step is void (another model answers it again). */
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

/** Requests to the model in one turn. The last one must answer. */
const MAX_STEPS = 10;
/** A read's result is cut past this: free plans count tokens per minute. */
const MAX_RESULT_CHARS = 12_000;

export type TurnSetup = {
  /** The fixed prompt and who is asking. */
  system: { fixed: string; context: string };
  caller: Caller;
  emit: Emit;
  /** Called after each change to the conversation, to save it. */
  save: (messages: ChatMessage[], pending: Pending | null) => Promise<void>;
};

export type TurnResult = { messages: ChatMessage[]; pending: Pending | null };

const toolResult = (id: string, content: string): ToolResult => ({ role: "tool", tool_call_id: id, content });

function resultText(result: ApiResult) {
  const text = JSON.stringify({ status: result.status, data: result.data });
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [cut: too long. Ask for less: filters, a smaller pageSize, one record.]`;
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

const invalid = (error: z.ZodError) => `Invalid input: ${JSON.stringify(z.flattenError(error).fieldErrors)}`;

function parseArguments(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    return null;
  }
}

async function runRead(call: ToolCall, input: unknown, setup: TurnSetup): Promise<ToolResult> {
  const parsed = getInput.safeParse(input);
  if (!parsed.success) return toolResult(call.id, invalid(parsed.error));
  const { path, query } = splitPath(parsed.data.path, parsed.data.query ?? {});
  if (!findEndpoint("GET", path)) {
    return toolResult(call.id, `GET ${path} is not an endpoint you can use. Use one from the API list.`);
  }
  setup.emit({ type: "lookup", path });
  const result = await callMizan({ method: "GET", path, query: query as Record<string, string> }, setup.caller);
  return toolResult(call.id, resultText(result));
}

function proposeChange(call: ToolCall, input: unknown): PendingChange | ToolResult {
  const parsed = changeInput.safeParse(input);
  if (!parsed.success) return toolResult(call.id, invalid(parsed.error));
  const { method, title, details, body } = parsed.data;
  const { path, query } = splitPath(parsed.data.path);
  if (Object.keys(query).length > 0) return toolResult(call.id, "Changes take no query string: put everything in the body.");
  if (!findEndpoint(method, path)) {
    return toolResult(call.id, `${method} ${path} is not an endpoint you can use. Use one from the API list.`);
  }
  return { id: call.id, method, path, body: body ?? undefined, title, details: details ?? [] };
}

/** Runs one change the user confirmed. */
export async function runChange(change: PendingChange, caller: Caller): Promise<ChangeOutcome> {
  const result = await callMizan({ method: change.method, path: change.path, body: change.body }, caller);
  return result.ok ? { status: "done", data: result.data } : { status: "failed", httpStatus: result.status, error: result.data };
}

export async function runChanges(pending: Pending, approve: boolean, setup: Pick<TurnSetup, "caller" | "emit">) {
  const results: ToolResult[] = [...pending.results];
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
  return inCallOrder(results, pending.order ?? []);
}

/**
 * Before a new turn: a turn that died after the model asked for tools (a crash, a restart)
 * leaves calls without results, which the APIs refuse. Answer them as interrupted.
 */
export function closeDanglingCalls(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !last.tool_calls?.length) return messages;
  return [...messages, ...last.tool_calls.map((call) => toolResult(call.id, "Interrupted before it ran; it did not happen."))];
}

/**
 * Runs the model until it answers or proposes changes. `start` ends with the user's
 * message (or the results of the changes they confirmed).
 */
export async function runTurn(start: ChatMessage[], setup: TurnSetup): Promise<TurnResult> {
  let messages = start;
  const system: ChatMessage = { role: "system", content: `${setup.system.fixed}\n\n${setup.system.context}` };
  for (let step = 0; step < MAX_STEPS; step++) {
    setup.emit({ type: "step" });
    const reply: ModelReply = await callModel(
      { messages: [system, ...messages], tools: TOOLS, toolChoice: step === MAX_STEPS - 1 ? "none" : "auto" },
      { onText: (delta) => setup.emit({ type: "text", delta }), onReset: () => setup.emit({ type: "retry" }) },
    );
    setup.emit({
      type: "usage",
      inputTokens: reply.usage.inputTokens - reply.usage.cachedTokens,
      outputTokens: reply.usage.outputTokens,
      cacheReadTokens: reply.usage.cachedTokens,
      cacheWriteTokens: 0,
    });

    if (reply.finishReason === "content_filter") {
      setup.emit({ type: "error", code: "ASSISTANT_REFUSED", message: "The assistant can't help with this request." });
      return { messages, pending: null };
    }

    const calls = reply.toolCalls;
    if (!reply.content && calls.length === 0) return { messages, pending: null };
    messages = [...messages, { role: "assistant", content: reply.content || null, ...(calls.length ? { tool_calls: calls } : {}) }];

    if (calls.length === 0) {
      await setup.save(messages, null);
      return { messages, pending: null };
    }

    // Calls cut off by the length limit can look valid: never run them.
    if (reply.finishReason === "length") {
      messages = [...messages, ...calls.map((call) => toolResult(call.id, "Your answer was cut off before this call was complete; it did not run. Try again with less."))];
      await setup.save(messages, null);
      continue;
    }

    const results: ToolResult[] = [];
    const changes: PendingChange[] = [];
    for (const call of calls) {
      const input = parseArguments(call);
      if (input === null) {
        results.push(toolResult(call.id, "The arguments were not valid JSON. Call the tool again."));
      } else if (call.function.name === "mizan_docs") {
        const parsed = docsInput.safeParse(input);
        results.push(toolResult(call.id, parsed.success ? apiDocs(parsed.data.sections) : invalid(parsed.error)));
      } else if (call.function.name === "mizan_get") {
        results.push(await runRead(call, input, setup));
      } else if (call.function.name === "mizan_change") {
        const proposal = proposeChange(call, input);
        if ("role" in proposal) results.push(proposal);
        else changes.push(proposal);
      } else {
        results.push(toolResult(call.id, `There is no tool named ${call.function.name}.`));
      }
    }

    if (changes.length > 0) {
      const pending: Pending = { results, changes, order: calls.map((call) => call.id) };
      await setup.save(messages, pending);
      setup.emit({ type: "confirm", actions: changes.map(({ body: _body, ...card }) => card) });
      return { messages, pending };
    }

    messages = [...messages, ...results];
    await setup.save(messages, null);
  }
  return { messages, pending: null };
}
