import { describe, expect, it, vi } from "vitest";
import { buildMime, createGmailSender, encodeHeaderText, GmailError, type GmailMessage } from "../src/lib/gmail.js";

const account = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", sender: "mizan.app@gmail.com" };
const message: GmailMessage = {
  fromName: "شركة النور للتجارة",
  to: "customer@example.com",
  subject: "فاتورة INV-12 من شركة النور للتجارة بقيمة 5,130 ج.م. — مستحقة 27 أكتوبر",
  html: "<p dir=\"rtl\">مرحباً، <b>فاتورتك</b> جاهزة.</p>",
  text: "مرحباً، فاتورتك جاهزة.",
  replyTo: "owner@example.com",
};

/** Decodes "=?UTF-8?B?...?=" words (folded or not) back to text. */
const decodeWords = (header: string) =>
  [...header.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8")).join("");

/** The headers of a MIME message, continuation lines joined. */
const headersOf = (mime: string) => {
  const head = mime.split("\r\n\r\n")[0]!.replace(/\r\n /g, " ");
  return Object.fromEntries(head.split("\r\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
};

/** The decoded body of the part with this content type. */
const partOf = (mime: string, type: string) => {
  const part = mime.split(/--mizan-[\w-]+/).find((p) => p.includes(`Content-Type: ${type};`))!;
  return Buffer.from(part.split("\r\n\r\n")[1]!.replace(/\s/g, ""), "base64").toString("utf8");
};

describe("encodeHeaderText", () => {
  it("encodes Arabic in words of at most 75 characters that decode back to the text", () => {
    const encoded = encodeHeaderText(message.subject);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(encoded)).toBe(message.subject);
  });

  it("never splits a character between two words (emoji included)", () => {
    const text = "😀".repeat(30) + "ميزان".repeat(10);
    expect(decodeWords(encodeHeaderText(text))).toBe(text);
  });

  it("turns line breaks into spaces, so no header can be smuggled in", () => {
    const encoded = encodeHeaderText("Hello\r\nBcc: evil@example.com");
    expect(encoded).not.toMatch(/\r\nBcc:/);
    expect(decodeWords(encoded)).toBe("Hello Bcc: evil@example.com");
  });
});

describe("buildMime", () => {
  it("writes From (the account, with the company's name), To, Reply-To and the subject", () => {
    const headers = headersOf(buildMime(account.sender, message));
    expect(headers.From).toMatch(/<mizan\.app@gmail\.com>$/);
    expect(decodeWords(headers.From!)).toBe("شركة النور للتجارة");
    expect(headers.To).toBe("<customer@example.com>");
    expect(headers["Reply-To"]).toBe("<owner@example.com>");
    expect(decodeWords(headers.Subject!)).toBe(message.subject);
    expect(headers["Content-Type"]).toMatch(/^multipart\/alternative; boundary="mizan-/);
  });

  it("carries the text and the HTML as UTF-8 alternatives", () => {
    const mime = buildMime(account.sender, message);
    expect(partOf(mime, "text/plain")).toBe(message.text);
    expect(partOf(mime, "text/html")).toBe(message.html);
  });

  it("leaves Reply-To out when there is none", () => {
    expect(headersOf(buildMime(account.sender, { ...message, replyTo: undefined }))).not.toHaveProperty("Reply-To");
  });

  it("keeps a broken address from adding headers", () => {
    const mime = buildMime(account.sender, { ...message, to: "a@example.com\r\nBcc: evil@example.com" });
    expect(mime.split("\r\n\r\n")[0]).not.toMatch(/\r\nBcc:/);
  });
});

/** A fake Google: answers the token and send endpoints from the given handlers. */
function fakeGoogle(handlers: { token?: () => Response; send?: (n: number) => Response }) {
  let sends = 0;
  let tokens = 0;
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return handlers.token?.() ?? Response.json({ access_token: `token-${++tokens}`, expires_in: 3599 });
    }
    sends++;
    return handlers.send?.(sends) ?? Response.json({ id: "msg" });
  });
  const calls = (part: string) => fetch.mock.calls.filter(([url]) => String(url).includes(part));
  return { fetch, calls };
}

describe("createGmailSender", () => {
  it("gets one access token for several emails and sends each as a base64url message", async () => {
    const google = fakeGoogle({});
    const send = createGmailSender(account, google.fetch as typeof fetch);
    await send(message);
    await send({ ...message, to: "second@example.com" });

    const tokenCalls = google.calls("oauth2.googleapis.com/token");
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0]![1]!.body as URLSearchParams);
    expect(Object.fromEntries(form)).toEqual({ client_id: "client", client_secret: "secret", refresh_token: "refresh", grant_type: "refresh_token" });

    const sendCalls = google.calls("gmail.googleapis.com");
    expect(sendCalls).toHaveLength(2);
    const [, init] = sendCalls[1]!;
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    const mime = Buffer.from(JSON.parse(init!.body as string).raw, "base64url").toString("utf8");
    expect(headersOf(mime).To).toBe("<second@example.com>");
  });

  it("gets a new access token once when Google rejects the one it has", async () => {
    const google = fakeGoogle({ send: (n) => (n === 1 ? new Response("expired", { status: 401 }) : Response.json({ id: "msg" })) });
    await createGmailSender(account, google.fetch as typeof fetch)(message);
    expect(google.calls("oauth2.googleapis.com/token")).toHaveLength(2);
    expect(google.calls("gmail.googleapis.com")).toHaveLength(2);
  });

  it("fails with Google's answer when the refresh token is no good", async () => {
    const google = fakeGoogle({ token: () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const error = await createGmailSender(account, google.fetch as typeof fetch)(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).detail).toMatchObject({ status: 400, body: expect.stringContaining("invalid_grant") });
    expect(google.calls("gmail.googleapis.com")).toHaveLength(0);
  });

  it("fails with Gmail's answer when it refuses the email", async () => {
    const google = fakeGoogle({ send: () => new Response("Gmail API has not been used in project", { status: 403 }) });
    const error = await createGmailSender(account, google.fetch as typeof fetch)(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).detail).toMatchObject({ status: 403, body: expect.stringContaining("not been used") });
  });

  it("fails cleanly when Google can't be reached", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await createGmailSender(account, fetch as typeof globalThis.fetch)(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).message).toMatch(/Could not reach Google/);
  });
});
