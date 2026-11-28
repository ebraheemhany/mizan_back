import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSelfUrlForTests } from "../src/modules/assistant/assistant.api.js";
import { setModelForTests } from "../src/modules/assistant/assistant.agent.js";
import { apiReference, ENDPOINTS, findEndpoint } from "../src/modules/assistant/assistant.catalog.js";
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});
beforeEach(resetDatabase);
afterEach(() => setModelForTests(null));

// ---------------------------------------------------------------------------
// A scripted Claude
// ---------------------------------------------------------------------------

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

const text = (value: string): Block => ({ type: "text", text: value });
let toolCounter = 0;
const read = (path: string, query?: Record<string, unknown>): Block => ({
  type: "tool_use",
  id: `toolu_${toolCounter++}`,
  name: "mizan_get",
  input: { path, ...(query ? { query } : {}) },
});
const change = (method: string, path: string, body: Record<string, unknown> | undefined, title: string): Block => ({
  type: "tool_use",
  id: `toolu_${toolCounter++}`,
  name: "mizan_change",
  input: { method, path, ...(body ? { body } : {}), title, details: ["تفصيلة"] },
});

function message(content: Block[]): BetaMessage {
  const stop_reason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: content.map((block) => (block.type === "text" ? { ...block, citations: null } : block)),
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

/** Claude's answers in order; each sees the request it answers. Returns every request made. */
function script(...answers: ((params: BetaMessageStreamParams) => Block[])[]) {
  const requests: BetaMessageStreamParams[] = [];
  setModelForTests(async (params, onText) => {
    requests.push(structuredClone(params));
    const answer = answers.shift();
    if (!answer) throw new Error("Claude was asked more than the script has");
    const content = answer(params);
    for (const block of content) if (block.type === "text") onText(block.text);
    return message(content);
  });
  return requests;
}

const say =
  (...content: Block[]) =>
  () =>
    content;

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

/** The last tool results Claude was sent (by tool_use id). */
function toolResults(params: BetaMessageStreamParams) {
  const last = params.messages.at(-1)!;
  const blocks = Array.isArray(last.content) ? last.content : [];
  return Object.fromEntries(
    blocks.filter((b: any) => b.type === "tool_result").map((b: any) => [b.tool_use_id, { content: String(b.content), isError: Boolean(b.is_error) }]),
  );
}

async function customer(token: string, name: string) {
  const res = await api().post("/api/customers").set(auth(token)).send({ name });
  expect(res.status).toBe(201);
  return res.body.customer as { id: string; name: string };
}

// ---------------------------------------------------------------------------

describe("the API reference", () => {
  it("lists only real endpoints, and the assistant may call nothing else", async () => {
    const { token } = await ownerSession();
    const reference = apiReference();
    expect(reference).toContain("POST /api/invoices — ");
    expect(reference).toContain("customerId: uuid, issueDate: date");
    expect(reference.length).toBeLessThan(40_000);

    // Every endpoint in the reference is routed (a missing route answers "Route ... not found").
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
  it("is off without a key, and says how much of the month's messages are used", async () => {
    const { token } = await ownerSession({ plan: "pro" });
    const off = await api().get("/api/assistant/status").set(auth(token));
    expect(off.body).toMatchObject({ enabled: false, usage: { used: 0, limit: 200 } });
    const refused = await ask(token, { text: "مرحبا" });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("ASSISTANT_OFF");

    script(say(text("أهلاً")));
    expect((await api().get("/api/assistant/status").set(auth(token))).body.enabled).toBe(true);
  });

  it("answers from the company's data: reads run at once, as the user", async () => {
    const { token } = await ownerSession();
    const nour = await customer(token, "شركة النور");
    const requests = script(
      say(text("بدور على العميل…"), read("/api/customers?q=النور", { pageSize: 5 })),
      (params) => {
        const [result] = Object.values(toolResults(params));
        expect(result!.isError).toBe(false);
        expect(result!.content).toContain(nour.id);
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

    // The fixed prompt is cached and the same for everyone; who is asking comes after it.
    const [first] = requests;
    const system = first!.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]!.text).not.toContain("شركة ميزان");
    expect(system[1]!.text).toContain("شركة ميزان");
    expect(system[1]!.text).toContain(businessToday());
    expect(first!.tools!.map((t: any) => t.name)).toEqual(["mizan_get", "mizan_change"]);

    // Tokens are counted for the company.
    const usage = await prisma.assistantUsage.findFirstOrThrow();
    expect(usage).toMatchObject({ messages: 1, inputTokens: 200, outputTokens: 40, cacheReadTokens: 100 });

    // The conversation reads back as bubbles; the page note and the reads are left out.
    const id = stream[0]!.id as string;
    const shown = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(shown.items).toEqual([
      { kind: "user", text: "رصيد شركة النور كام؟" },
      { kind: "assistant", text: `بدور على العميل…\n\nالعميل [شركة النور](/customers/${nour.id}) رصيده صفر.` },
    ]);
    expect(shown.pending).toBeNull();
    const list = (await api().get("/api/assistant/conversations").set(auth(token))).body.conversations;
    expect(list).toHaveLength(1);
  });

  it("proposes a change and waits; it happens only when the user confirms", async () => {
    const { token } = await ownerSession();
    const requests = script(say(text("هضيف العميل."), change("POST", "/api/customers", { name: "مكتبة الأمل" }, "إضافة عميل: مكتبة الأمل")));

    const first = events(await ask(token, { text: "ضيف عميل اسمه مكتبة الأمل" }));
    const id = first[0]!.id as string;
    const confirm = first.find((e) => e.type === "confirm")!;
    expect(confirm.actions).toEqual([
      expect.objectContaining({ method: "POST", path: "/api/customers", title: "إضافة عميل: مكتبة الأمل", details: ["تفصيلة"] }),
    ]);
    expect(await prisma.customer.count()).toBe(0);

    const waiting = (await api().get(`/api/assistant/conversations/${id}`).set(auth(token))).body.conversation;
    expect(waiting.pending).toHaveLength(1);
    expect(waiting.items.at(-1)).toMatchObject({ kind: "action", status: "pending" });

    script((params) => {
      const [result] = Object.values(toolResults(params));
      expect(JSON.parse(result!.content)).toMatchObject({ status: "done", data: { customer: { name: "مكتبة الأمل" } } });
      return [text("تمت إضافة العميل.")];
    });
    const second = events(await decide(token, id, true));
    expect(second).toContainEqual({ type: "action", id: confirm.actions[0].id, title: "إضافة عميل: مكتبة الأمل", outcome: "done" });
    expect(await prisma.customer.count()).toBe(1);

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
    expect(requests).toHaveLength(1);
  });

  it("cancelled, or replaced by a new message, the change doesn't happen and Claude is told", async () => {
    const { token } = await ownerSession();
    script(say(change("DELETE", "/api/customers/3f2504e0-4f89-41d3-9a0c-0305e82c3301", undefined, "حذف عميل")));
    const id = events(await ask(token, { text: "امسح العميل" }))[0]!.id as string;

    script((params) => {
      expect(Object.values(toolResults(params))[0]!.content).toBe('{"status":"declined"}');
      return [text("تمام، مش هحذفه.")];
    });
    expect(events(await decide(token, id, false))).toContainEqual(expect.objectContaining({ type: "action", outcome: "declined" }));

    script(say(change("POST", "/api/customers", { name: "عميل جديد" }, "إضافة عميل")));
    events(await ask(token, { text: "طب ضيف عميل" }, id));
    script((params) => {
      const last = params.messages.at(-1)!.content as any[];
      expect(last[0]).toMatchObject({ type: "tool_result" });
      expect(JSON.parse(last[0].content)).toMatchObject({ status: "declined" });
      expect(last.at(-1)).toMatchObject({ type: "text", text: "لا خلاص" });
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
    script(say(change("POST", "/api/customers", { name: "ممنوع" }, "إضافة عميل")));
    const id = events(await ask(viewer.token, { text: "ضيف عميل" }))[0]!.id as string;
    script((params) => {
      const outcome = JSON.parse(Object.values(toolResults(params))[0]!.content);
      expect(outcome).toMatchObject({ status: "failed", httpStatus: 403 });
      return [text("صلاحياتك لا تسمح بإضافة عملاء.")];
    });
    const done = events(await decide(viewer.token, id, true));
    expect(done).toContainEqual(expect.objectContaining({ type: "action", outcome: "failed" }));
    expect(await prisma.customer.count()).toBe(0);
  });

  it("calls only endpoints of the reference; anything else is refused before it runs", async () => {
    const { token } = await ownerSession();
    script(
      say(read("/api/admin/companies"), change("POST", "/api/billing/cancel", undefined, "إلغاء الاشتراك")),
      (params) => {
        const results = Object.values(toolResults(params));
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.isError && r.content.includes("not an endpoint"))).toBe(true);
        return [text("لا أستطيع ذلك.")];
      },
    );
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

  it("a failure mid-turn is reported, and the next message still works", async () => {
    const { token } = await ownerSession();
    setModelForTests(async () => {
      throw new Error("connection dropped");
    });
    const failed = events(await ask(token, { text: "مرحبا" }));
    expect(failed).toContainEqual(expect.objectContaining({ type: "error", code: "ASSISTANT_FAILED" }));
    expect(failed.filter((e) => e.type === "retry")).toHaveLength(2);
    const id = failed[0]!.id as string;

    // The turn left the user's message unanswered; the next one goes with it, and the lock is gone.
    script((params) => {
      expect(params.messages.map((m) => m.role)).toEqual(["user", "user"]);
      return [text("أهلاً")];
    });
    const next = events(await ask(token, { text: "مرحبا تاني" }, id));
    expect(next.some((e) => e.type === "error")).toBe(false);
  });
});
