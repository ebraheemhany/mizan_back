// The assistant against a real model (Groq), end to end. Skipped unless a key is given:
//   GROQ_LIVE_KEY=gsk_... npx vitest run test/assistant.live.test.ts
// It spends a few requests of that key's free daily quota.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSelfUrlForTests } from "../src/modules/assistant/assistant.api.js";
import { setProvidersForTests } from "../src/modules/assistant/assistant.llm.js";
import { api, app, auth, ownerSession, prisma, resetDatabase } from "./helpers.js";

const key = process.env["GROQ_LIVE_KEY"];
/** What the run did, for a person to read (GROQ_LIVE_LOG=file, else the console). */
const started = Date.now();
const log = (...parts: unknown[]) => {
  const line = `[${((Date.now() - started) / 1000).toFixed(0)}s] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
  if (process.env["GROQ_LIVE_LOG"]) fs.appendFileSync(process.env["GROQ_LIVE_LOG"], line);
  else process.stdout.write(line);
};

type Event = { type: string; [k: string]: any };
const events = (res: { text: string }): Event[] =>
  res.text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Event);
const said = (stream: Event[]) => stream.filter((e) => e.type === "text").map((e) => e.delta).join("");

describe.skipIf(!key)("the assistant with a real model", () => {
  let server: Server;
  beforeAll(async () => {
    await resetDatabase();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    setSelfUrlForTests(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const models = (process.env["GROQ_LIVE_MODELS"] ?? "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b").split(",");
    setProvidersForTests(models.map((model) => ({ name: `groq:${model}`, baseUrl: "https://api.groq.com/openai/v1", apiKey: key, model })));
  });
  afterAll(async () => {
    setProvidersForTests(null);
    setSelfUrlForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  it("answers in Arabic from the data, and adds a customer only after confirmation", { timeout: 600_000 }, async () => {
    const { token } = await ownerSession();
    await api().post("/api/customers").set(auth(token)).send({ name: "شركة النور للتجارة", city: "القاهرة" });

    const first = events(await api().post("/api/assistant/conversations").set(auth(token)).send({ text: "كام عميل عندي؟ وفي أي مدينة؟" }));
    const id = first[0]!.id as string;
    log("Q1 lookups:", first.filter((e) => e.type === "lookup").map((e) => e.path), "\nA1:", said(first), first.filter((e) => e.type === "error"));
    expect(first.some((e) => e.type === "error")).toBe(false);
    expect(said(first)).toMatch(/القاهرة|1|واحد/);

    const second = events(
      await api().post(`/api/assistant/conversations/${id}/messages`).set(auth(token)).send({ text: "ضيف عميل جديد اسمه مكتبة الأمل في الإسكندرية" }),
    );
    log("A2 waits:", second.filter((e) => e.type === "wait").map((e) => e.seconds), "lookups:", second.filter((e) => e.type === "lookup").map((e) => e.path), "\nA2:", said(second), JSON.stringify(second.find((e) => e.type === "confirm")), second.filter((e) => e.type === "error"));
    const confirm = second.find((e) => e.type === "confirm");
    expect(confirm).toBeTruthy();
    expect(await prisma.customer.count()).toBe(1);

    const third = events(await api().post(`/api/assistant/conversations/${id}/decision`).set(auth(token)).send({ approve: true }));
    log("A3:", third.filter((e) => e.type === "action"), said(third));
    expect(third).toContainEqual(expect.objectContaining({ type: "action", outcome: "done" }));
    const added = await prisma.customer.findFirst({ where: { name: { contains: "الأمل" } } });
    expect(added?.city).toContain("الإسكندرية");
    log("usage:", await prisma.assistantUsage.findFirst());
  });
});
