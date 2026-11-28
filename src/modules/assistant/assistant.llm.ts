// The model behind the assistant: any OpenAI-compatible chat API (Groq's free plan, your
// own Ollama server, OpenRouter...). Several can be set; they are tried in order, and
// the next one takes over when one is out of its free quota, rejects the key, or is down.
import { config } from "../../config.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// The conversation, in the chat-completions format every provider speaks
// ---------------------------------------------------------------------------

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ModelRequest = { messages: ChatMessage[]; tools: ToolDef[]; toolChoice: "auto" | "none" };

export type ModelReply = {
  content: string;
  toolCalls: ToolCall[];
  /** stop, tool_calls, length (cut off), content_filter... */
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  provider: string;
};

export type StreamHooks = {
  onText: (delta: string) => void;
  /** The text streamed so far is void: another provider starts this answer again. */
  onReset: () => void;
};

export type ModelCall = (request: ModelRequest, hooks: StreamHooks) => Promise<ModelReply>;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

type Provider = { name: string; baseUrl: string; apiKey: string | undefined; model: string };

let providersOverride: Provider[] | null = null;

/** Tests point the assistant at local fake providers. */
export function setProvidersForTests(list: Provider[] | null) {
  providersOverride = list;
  coolingUntil.clear();
}

export function providers(): Provider[] {
  if (providersOverride) return providersOverride;
  const list: Provider[] = [];
  if (config.LLM_BASE_URL && config.LLM_MODEL) {
    list.push({ name: "custom", baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL });
  }
  if (config.GROQ_API_KEY) {
    list.push({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: config.GROQ_API_KEY, model: config.GROQ_MODEL });
  }
  return list;
}

/** Why no provider could answer. */
export class ModelUnavailableError extends Error {
  constructor(
    /** limit: every one is out of its quota for now; auth: the keys were refused; down: errors or no answer. */
    public readonly reason: "limit" | "auth" | "down",
    message: string,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

class ProviderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Seconds to wait, from a 429's retry-after. */
    public readonly retryAfter: number | null,
    /** Text was already streamed when it failed. */
    public readonly streamed = false,
  ) {
    super(message);
  }
}

/** Providers out of quota are skipped until this time (ms), instead of being asked again. */
const coolingUntil = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short waits (a per-minute limit) are waited out; longer ones move on to the next provider. */
const MAX_WAIT_SECONDS = 10;

const realModelCall: ModelCall = async (request, hooks) => {
  const list = providers();
  const failures: ProviderError[] = [];
  for (const provider of list) {
    if ((coolingUntil.get(provider.name) ?? 0) > Date.now()) {
      failures.push(new ProviderError(429, `${provider.name} is out of quota for now`, null));
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await streamChat(provider, request, hooks);
      } catch (err) {
        const failure = err instanceof ProviderError ? err : new ProviderError(0, (err as Error).message, null);
        if (failure.streamed) hooks.onReset();
        logger.warn({ provider: provider.name, status: failure.status, err: failure.message }, "assistant model call failed");
        if (failure.status === 429 && failure.retryAfter !== null && failure.retryAfter <= MAX_WAIT_SECONDS && attempt < 2) {
          await sleep(failure.retryAfter * 1000 + 250);
          continue;
        }
        if (failure.status === 429) coolingUntil.set(provider.name, Date.now() + (failure.retryAfter ?? 60) * 1000);
        failures.push(failure);
        break;
      }
    }
  }
  if (failures.length > 0 && failures.every((f) => f.status === 401 || f.status === 403)) {
    throw new ModelUnavailableError("auth", "The assistant's API keys were refused");
  }
  if (failures.some((f) => f.status === 429)) {
    throw new ModelUnavailableError("limit", "The free models are out of quota for now");
  }
  throw new ModelUnavailableError("down", "No model could answer");
};

let modelOverride: ModelCall | null = null;

/** Tests script the model's answers instead of calling one. */
export function setModelForTests(model: ModelCall | null) {
  modelOverride = model;
  coolingUntil.clear();
}

export const assistantEnabled = () => modelOverride !== null || providers().length > 0;

export const callModel: ModelCall = (request, hooks) => (modelOverride ?? realModelCall)(request, hooks);

// ---------------------------------------------------------------------------
// One streamed request
// ---------------------------------------------------------------------------

type Chunk = {
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
  x_groq?: { usage?: Usage };
  error?: { message?: string; code?: unknown };
};

type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };

async function streamChat(provider: Provider, request: ModelRequest, hooks: StreamHooks): Promise<ModelReply> {
  let res: Response;
  try {
    res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: request.messages,
        tools: request.tools,
        tool_choice: request.toolChoice,
        max_tokens: 3000,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    throw new ProviderError(0, `no answer: ${(err as Error).message}`, null);
  }
  if (!res.ok || !res.body) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ProviderError(res.status, (await res.text().catch(() => "")).slice(0, 500), Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }

  let content = "";
  const calls: { id: string; name: string; arguments: string }[] = [];
  let finishReason: string | null = null;
  let usage: Usage = {};

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const chunk = JSON.parse(data) as Chunk;
        if (chunk.error) throw new ProviderError(500, chunk.error.message ?? "error in the stream", null, content.length > 0);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          hooks.onText(delta.content);
        }
        for (const part of delta?.tool_calls ?? []) {
          const index = part.index ?? calls.length;
          calls[index] ??= { id: "", name: "", arguments: "" };
          const call = calls[index]!;
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const reported = chunk.usage ?? chunk.x_groq?.usage;
        if (reported) usage = reported;
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(0, `the stream broke: ${(err as Error).message}`, null, content.length > 0);
  }

  return {
    content,
    toolCalls: calls
      .filter((call) => call?.name)
      .map((call, i) => ({
        // Some servers (Ollama) send no ids: the results must still point at their call.
        id: call.id || `call_${Date.now().toString(36)}_${i}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      })),
    finishReason,
    usage: {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    },
    provider: provider.name,
  };
}
