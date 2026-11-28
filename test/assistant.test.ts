import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSelfUrlForTests } from "../src/modules/assistant/assistant.api.js";
import { apiDocs, apiIndex, ENDPOINTS, findEndpoint } from "../src/modules/assistant/assistant.catalog.js";
import {
  callModel,
  ModelUnavailableError,
  setModelForTests,
  setProvidersForTests,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from "../src/modules/assistant/assistant.llm.js";
import { businessToday } from "../src/lib/dates.js";
import { api, app, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

// The assistant calls Mizan's API over HTTP as the user: run the app on a port for it.
let server: Server;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  setSelfUrlForTests(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(async () => {
  setSelfUrlForTests(null);
  setModelForTests(null);
  setProvidersForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});
beforeEach(resetDatabase);
afterEach(() => {
  setModelForTests(null);
  setProvidersForTests(null);
});

// ---------------------------------------------------------------------------
// A scripted model
// ---------------------------------------------------------------------------

type Part = { text: string } | ToolCall;

const text = (value: string): Part => ({ text: value });
let callCounter = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: `call_${callCounter++}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const docs = (...sections: string[]) => call("mizan_docs", { sections });
const read = (path: string, query?: Record<string, unknown>) => call("mizan_get", { path, ...(query ? { query } : {}) });
const change = (method: string, path: string, body: Record<string, unknown> | undefined, title: string) =>
  call("mizan_change", { method, path, ...(body ? { body } : {}), title, details: ["تفصيلة"] });

function reply(parts: Part[]): ModelReply {
  const toolCalls = parts.filter((p): p is ToolCall => "function" in p);
  return {
    content: parts.flatMap((p) => ("text" in p ? [p.text] : [])).join(""),
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50 },
    provider: "test",
  };
}

/** The model's answers in order; each sees the request it answers. Returns every request made. */
function script(...answers: ((request: ModelRequest) => Part[])[]) {
  const requests: ModelRequest[] = [];
  setModelForTests(async (request, hooks) => {
    requests.push(structuredClone(request));
    const answer = answers.shift();
    if (!answer) throw new Error("The model was asked more than the script has");
    const parts = answer(request);
    for (const part of parts) if ("text" in part) hooks.onText(part.text);
    return reply(parts);
  });
  return requests;
}

const say =
  (...parts: Part[]) =>
  () =>
    parts;

type Event = { type: string; [key: string]: any };

/** The server-sent events of a response. */
const events = (res: { text: string }): Event[] =>
  res.text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Event);

const ask = (token: string, body: Record<string, unknown>, conversationId?: string) =>
  api()
    .post(conversationId ? `/api/assistant/conversations/${conversationId}/messages` : "/api/assistant/conversations")
    .set(auth(token))
    .send(body);

const decide = (token: string, conversationId: string, approve: boolean) =>
  api().post(`/api/assistant/conversations/${conversationId}/decision`).set(auth(token)).send({ approve });

/** The tool results at the end of a request (by call id). */
function toolResults(request: ModelRequest) {
  const results: Record<string, string> = {};
  for (const message of request.messages) if (message.role === "tool") results[message.tool_call_id] = message.content;
  return results;
}
const resultOf = (request: ModelRequest, part: Part) => toolResults(request)[(part as ToolCall).id]!;

async function customer(token: string, name: string) {
  const res = await api().post("/api/customers").set(auth(token)).send({ name });
  expect(res.status).toBe(201);
  return res.body.customer as { id: string; name: string };
}

// ---------------------------------------------------------------------------

describe("the API list", () => {
  it("lists only real endpoints, and the assistant may call nothing else", async () => {
    const { token } = await ownerSession();
    // The prompt has one line per endpoint; the bodies come from the docs tool.
    const index = apiIndex();
    expect(index).toContain("POST /api/invoices — ");
    expect(index).not.toContain("customerId: uuid");
    expect(index.length).toBeLessThan(16_000);
    expect(apiDocs(["invoices"])).toContain("customerId: uuid, issueDate: date");
    expect(apiDocs(["nope"])).toContain("No such section");

    // Every endpoint in the list is routed (a missing route answers "Route ... not found").
    for (const endpoint of ENDPOINTS) {
      const path = endpoint.path
        .replace(":month", "2026-01")
        .replace(":ref", "999999")
        .replace(/:[A-Za-z]+/g, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
      const method = endpoint.method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";
      const res = await api()[method](path).set(auth(token)).send(endpoint.body ? {} : undefined);
      expect(`${endpoint.method} ${path} ${res.status} ${res.body?.error?.message ?? ""}`).not.toMatch(/ 404 Route /);
    }

    expect(findEndpoint("GET", "/api/invoices/1044")).toBeTruthy();
    expect(findEndpoint("POST", "/api/customers")).toBeTruthy();
    expect(findEndpoint("GET", "/api/admin/companies")).toBeNull();
    expect(findEndpoint("POST", "/api/auth/change-password")).toBeNull();
    expect(findEndpoint("POST", "/api/billing/checkout")).toBeNull();
    expect(findEndpoint("GET", "/api/customers/../admin")).toBeNull();
    expect(findEndpoint("DELETE", "/api/invoices/1044")).toBeNull();
  });
});

describe("the assistant", () => {
  it("is off with no model set up, and says how much of the month's messages are used", async () => {
    const { token } = await ownerSession({ plan: "pro" });
    const off = await api().get("/api/assistant/status").set(auth(token));
    expect(off.body).toMatchObject({ enabled: false, usage: { used: 0, limit: 200 } });
    const refused = await ask(token, { text: "مرحبا" });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("ASSISTANT_OFF");

    script(say(text("أهلاً")));
    expect((await api().get("/api/assistant/status").set(auth(token))).body.enabled).toBe(true);
  });

  it("answers from the company's data: docs and reads run at once, as the user", async () => {
    const { token } = await ownerSession();
    const nour = await customer(token, "شركة النور");
    const lookup = docs("customers");
    const search = read("/api/customers?q=النور", { pageSize: 5 });
    const requests = script(
      say(lookup),
      (request) => {
        expect(resultOf(request, lookup)).toContain("q?: string(max 100)");
        return [text("بدور على العميل…"), search];
      },
      (request) => {
        expect(resultOf(request, search)).toContain(nour.id);
        return [text(`العميل [شركة النور](/customers/${nour.id}) رصيده صفر.`)];
      },
    );

    const res = await ask(token, { text: "رصيد شركة النور كام؟", page: "/customers" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const stream = events(res);
    expect(stream[0]).toMatchObject({ type: "conversation", title: "رصيد شركة النور كام؟" });
    expect(stream).toContainEqual({ type: "lookup", path: "/api/customers" });
    expect(stream.filter((e) => e.type === "text").map((e) => e.delta).join("")).toContain("رصيده صفر");
    expect(stream.at(-1)).toMatchObject({ type: "done", usage: { used: 1, limit: 1000 } });

    // One system message: the fixed part first (the same for everyone), who is asking last.
    const [first] = requests;
    const system = first!.messages[0]!;
    expect(system.role).toBe("system");
    expect(system.content!.startsWith("You are Mizan's assistant")).toBe(true);
    expect(system.content).toContain("شركة ميزان");
    expect(system.content).toContain(businessToday());
    expect(system.content!.indexOf("شركة ميزان")).toBeGreaterThan(system.content!.indexOf("### settings"));
    expect(first!.tools.map((t) => t.function.name)).toEqual(["mizan_docs", "mizan_get", "mizan_change"]);
    expect(first!.messages[1]).toEqual({ role: "user", content: "[The user is on this page of the app: /customers]\nرصيد شركة النور كام؟" });

    // Tokens are counted for the company.
    const usage = await prisma.assistantUsage.findFirstOrThrow();
    expect(usage).toMatchObject({ messages: 1, inputTokens: 150, outputTokens: 60, cacheReadTokens: 150 });

    // The conversation reads back as bubbles; the page note, docs and reads are left out.
    const id = stream[0]!.id as string;
    const shown = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(shown.items).toEqual([
      { kind: "user", text: "رصيد شركة النور كام؟" },
      { kind: "assistant", text: `بدور على العميل…\n\nالعميل [شركة النور](/customers/${nour.id}) رصيده صفر.` },
    ]);
    expect(shown.pending).toBeNull();
    expect((await api().get("/api/assistant/conversations").set(auth(token))).body.conversations).toHaveLength(1);
  });

  it("proposes a change and waits; it happens only when the user confirms", async () => {
    const { token } = await ownerSession();
    const lookup = read("/api/customers", { q: "الأمل" });
    const add = change("POST", "/api/customers", { name: "مكتبة الأمل" }, "إضافة عميل: مكتبة الأمل");
    script(say(text("هضيف العميل."), lookup, add));

    const first = events(await ask(token, { text: "ضيف عميل اسمه مكتبة الأمل" }));
    const id = first[0]!.id as string;
    const confirm = first.find((e) => e.type === "confirm")!;
    expect(confirm.actions).toEqual([
      { id: add.id, method: "POST", path: "/api/customers", title: "إضافة عميل: مكتبة الأمل", details: ["تفصيلة"] },
    ]);
    expect(await prisma.customer.count()).toBe(0);

    const waiting = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(waiting.pending).toHaveLength(1);
    expect(waiting.items.at(-1)).toMatchObject({ kind: "action", status: "pending" });

    const requests = script((request) => {
      // Every call of the turn is answered, in the order the model made them.
      const tools = request.messages.filter((m) => m.role === "tool");
      expect(tools.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual([lookup.id, add.id]);
      expect(JSON.parse(resultOf(request, add))).toMatchObject({ status: "done", data: { customer: { name: "مكتبة الأمل" } } });
      return [text("تمت إضافة العميل.")];
    });
    const second = events(await decide(token, id, true));
    expect(second).toContainEqual({ type: "action", id: add.id, title: "إضافة عميل: مكتبة الأمل", outcome: "done" });
    expect(await prisma.customer.count()).toBe(1);
    expect(requests).toHaveLength(1);

    // Confirming twice doesn't do it twice.
    const again = await decide(token, id, true);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("NOTHING_TO_CONFIRM");
    expect(await prisma.customer.count()).toBe(1);

    const shown = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(shown.items.find((i: any) => i.kind === "action")).toMatchObject({ status: "done" });
    expect(shown.items.at(-1)).toEqual({ kind: "assistant", text: "تمت إضافة العميل." });
    // Confirming isn't a new message for the plan.
    expect((await prisma.assistantUsage.findFirstOrThrow()).messages).toBe(1);
  });

  it("cancelled, or replaced by a new message, the change doesn't happen and the model is told", async () => {
    const { token } = await ownerSession();
    const remove = change("DELETE", "/api/customers/3f2504e0-4f89-41d3-9a0c-0305e82c3301", undefined, "حذف عميل");
    script(say(remove));
    const id = events(await ask(token, { text: "امسح العميل" }))[0]!.id as string;

    script((request) => {
      expect(resultOf(request, remove)).toBe('{"status":"declined"}');
      return [text("تمام، مش هحذفه.")];
    });
    expect(events(await decide(token, id, false))).toContainEqual(expect.objectContaining({ type: "action", outcome: "declined" }));

    const add = change("POST", "/api/customers", { name: "عميل جديد" }, "إضافة عميل");
    script(say(add));
    events(await ask(token, { text: "طب ضيف عميل" }, id));
    script((request) => {
      expect(JSON.parse(resultOf(request, add))).toMatchObject({ status: "declined" });
      // The user's words come after the results, as their own message.
      expect(request.messages.at(-1)).toEqual({ role: "user", content: "لا خلاص" });
      return [text("ماشي.")];
    });
    events(await ask(token, { text: "لا خلاص" }, id));
    expect(await prisma.customer.count()).toBe(0);
    const shown = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(shown.items.filter((i: any) => i.kind === "action").map((i: any) => i.status)).toEqual(["declined", "declined"]);
  });

  it("can't do more than the user: the API's permissions apply to what they confirm", async () => {
    const { token: owner } = await ownerSession();
    const viewer = await teamMember(owner, "viewer");
    const add = change("POST", "/api/customers", { name: "ممنوع" }, "إضافة عميل");
    script(say(add));
    const id = events(await ask(viewer.token, { text: "ضيف عميل" }))[0]!.id as string;
    script((request) => {
      expect(JSON.parse(resultOf(request, add))).toMatchObject({ status: "failed", httpStatus: 403 });
      return [text("صلاحياتك لا تسمح بإضافة عملاء.")];
    });
    const done = events(await decide(viewer.token, id, true));
    expect(done).toContainEqual(expect.objectContaining({ type: "action", outcome: "failed" }));
    expect(await prisma.customer.count()).toBe(0);
  });

  it("calls only endpoints of the list; anything else is refused before it runs", async () => {
    const { token } = await ownerSession();
    const admin = read("/api/admin/companies");
    const cancel = change("POST", "/api/billing/cancel", undefined, "إلغاء الاشتراك");
    const broken: ToolCall = { id: "call_broken", type: "function", function: { name: "mizan_get", arguments: "{not json" } };
    script(say(admin, cancel, broken), (request) => {
      expect(resultOf(request, admin)).toContain("not an endpoint");
      expect(resultOf(request, cancel)).toContain("not an endpoint");
      expect(resultOf(request, broken)).toContain("not valid JSON");
      return [text("لا أستطيع ذلك.")];
    });
    const stream = events(await ask(token, { text: "الغي الاشتراك" }));
    expect(stream.some((e) => e.type === "confirm" || e.type === "lookup")).toBe(false);
  });

  it("stops at the plan's messages for the month", async () => {
    const { token, companyId } = await ownerSession({ plan: "free" });
    await prisma.assistantUsage.create({ data: { companyId, month: businessToday().slice(0, 7), messages: 20 } });
    script(say(text("…")));
    const res = await ask(token, { text: "مرحبا" });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "PLAN_LIMIT_ASSISTANT", details: { limit: 20 } });
    expect(await prisma.assistantConversation.count()).toBe(0);
  });

  it("a conversation is its owner's only", async () => {
    const { token: owner } = await ownerSession();
    const other = await teamMember(owner, "accountant");
    script(say(text("أهلاً")));
    const id = events(await ask(owner, { text: "مرحبا" }))[0]!.id as string;
    expect((await api().get(`/api/assistant/conversations/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await ask(other.token, { text: "؟" }, id)).status).toBe(404);
    expect((await api().delete(`/api/assistant/conversations/${id}`).set(auth(other.token))).status).toBe(404);
    expect((await api().delete(`/api/assistant/conversations/${id}`).set(auth(owner))).status).toBe(204);
    expect(await prisma.assistantConversation.count()).toBe(0);
  });

  it("a conversation that grew too long asks for a new one", async () => {
    const { token, companyId, userId } = await ownerSession();
    const long = [{ role: "user", content: "x".repeat(100_000) }];
    const row = await prisma.assistantConversation.create({ data: { title: "طويلة", companyId, userId, messages: long } });
    script(say(text("…")));
    const res = await ask(token, { text: "كمان سؤال" }, row.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ASSISTANT_CONVERSATION_FULL");
    expect(await prisma.assistantUsage.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The free providers behind it (OpenAI-compatible chat APIs), faked on a local port
// ---------------------------------------------------------------------------

type Behaviour = { status?: number; retryAfter?: string; chunks?: unknown[]; breakAfter?: number };

describe("the model providers", () => {
  let fake: Server;
  let base: string;
  const behaviours: Record<string, Behaviour> = {};
  const seen: { provider: string; body: any; auth?: string }[] = [];

  beforeAll(async () => {
    const providerApp = express();
    providerApp.use(express.json({ limit: "5mb" }));
    providerApp.post("/:provider/v1/chat/completions", (req, res) => {
      const name = String(req.params.provider);
      seen.push({ provider: name, body: req.body, auth: req.get("authorization") });
      const b = behaviours[name] ?? {};
      if (b.status) {
        if (b.retryAfter) res.set("retry-after", b.retryAfter);
        res.status(b.status).json({ error: { message: "nope" } });
        return;
      }
      res.set("Content-Type", "text/event-stream");
      res.flushHeaders();
      const chunks = b.chunks ?? [];
      chunks.forEach((chunk, i) => {
        if (b.breakAfter !== undefined && i >= b.breakAfter) return;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
      if (b.breakAfter !== undefined) {
        // The connection drops after part of the answer reached the app.
        setTimeout(() => res.socket?.destroy(), 100);
        return;
      }
      res.end("data: [DONE]\n\n");
    });
    fake = providerApp.listen(0);
    await new Promise<void>((resolve) => fake.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));
  beforeEach(() => {
    seen.length = 0;
    for (const key of Object.keys(behaviours)) delete behaviours[key];
  });

  const provider = (name: string) => ({ name, baseUrl: `${base}/${name}/v1`, apiKey: `key-${name}`, model: `model-${name}` });
  const request: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [], toolChoice: "auto" };
  const delta = (d: unknown, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
  const answer = (words: string[]) => [
    ...words.map((w) => delta({ content: w })),
    delta({}, "stop"),
    { choices: [], usage: { prompt_tokens: 300, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 200 } } },
  ];

  it("streams text and assembles tool calls sent in pieces", async () => {
    setProvidersForTests([provider("one")]);
    behaviours.one = {
      chunks: [
        delta({ content: "أشوف " }),
        delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "mizan_get", arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"/api/dashboard"}' } }] }),
        delta({ tool_calls: [{ index: 1, function: { name: "mizan_docs", arguments: '{"sections":["invoices"]}' } }] }),
        delta({}, "tool_calls"),
        { choices: [], x_groq: { usage: { prompt_tokens: 50, completion_tokens: 5 } } },
      ],
    };
    const texts: string[] = [];
    const result = await callModel(request, { onText: (d) => texts.push(d), onReset: () => texts.push("RESET") });
    expect(texts).toEqual(["أشوف "]);
    expect(result).toMatchObject({ content: "أشوف ", finishReason: "tool_calls", provider: "one", usage: { inputTokens: 50, outputTokens: 5 } });
    expect(result.toolCalls[0]).toEqual({ id: "call_a", type: "function", function: { name: "mizan_get", arguments: '{"path":"/api/dashboard"}' } });
    // No id from the server: one is made up so the result can point at the call.
    expect(result.toolCalls[1]!.id).toMatch(/^call_/);
    expect(result.toolCalls[1]!.function.name).toBe("mizan_docs");
    expect(seen[0]).toMatchObject({ auth: "Bearer key-one", body: { model: "model-one", stream: true, tool_choice: "auto" } });
  });

  it("moves to the next provider when one is out of quota, and skips it for a while", async () => {
    setProvidersForTests([provider("one"), provider("two")]);
    behaviours.one = { status: 429, retryAfter: "3600" };
    behaviours.two = { chunks: answer(["أهلاً"]) };
    const first = await callModel(request, { onText: () => {}, onReset: () => {} });
    expect(first).toMatchObject({ content: "أهلاً", provider: "two", usage: { inputTokens: 300, cachedTokens: 200 } });
    await callModel(request, { onText: () => {}, onReset: () => {} });
    // The second time, the one out of quota isn't asked again.
    expect(seen.map((s) => s.provider)).toEqual(["one", "two", "two"]);
  });

  it("an answer that breaks halfway is started again by the next provider", async () => {
    setProvidersForTests([provider("one"), provider("two")]);
    behaviours.one = { chunks: answer(["نص ", "ناقص"]), breakAfter: 1 };
    behaviours.two = { chunks: answer(["نص كامل"]) };
    const texts: string[] = [];
    const result = await callModel(request, { onText: (d) => texts.push(d), onReset: () => texts.push("RESET") });
    expect(texts).toEqual(["نص ", "RESET", "نص كامل"]);
    expect(result.content).toBe("نص كامل");
  });

  it("says why nothing could answer: out of quota, or keys refused", async () => {
    setProvidersForTests([provider("one"), provider("two")]);
    behaviours.one = { status: 401 };
    behaviours.two = { status: 429, retryAfter: "600" };
    await expect(callModel(request, { onText: () => {}, onReset: () => {} })).rejects.toMatchObject({ reason: "limit" });

    setProvidersForTests([provider("one"), provider("three")]);
    behaviours.three = { status: 403 };
    await expect(callModel(request, { onText: () => {}, onReset: () => {} })).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(callModel(request, { onText: () => {}, onReset: () => {} })).rejects.toMatchObject({ reason: "auth" });
  });

  it("in the app: every free model out of quota pauses only the assistant, and says so", async () => {
    const { token } = await ownerSession();
    setProvidersForTests([provider("one")]);
    behaviours.one = { status: 429, retryAfter: "600" };
    const stream = events(await ask(token, { text: "مرحبا" }));
    expect(stream).toContainEqual(expect.objectContaining({ type: "error", code: "ASSISTANT_QUOTA" }));
    expect((await api().get("/api/customers").set(auth(token))).status).toBe(200);

    // A real answer through the provider, end to end.
    setProvidersForTests([provider("two")]);
    behaviours.two = { chunks: answer(["أهلاً ", "بيك"]) };
    const ok = events(await ask(token, { text: "مرحبا" }));
    expect(ok.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("أهلاً بيك");
    expect(seen.at(-1)!.body.messages[0].role).toBe("system");
    expect(seen.at(-1)!.body.tools.map((t: any) => t.function.name)).toEqual(["mizan_docs", "mizan_get", "mizan_change"]);
  });
});
