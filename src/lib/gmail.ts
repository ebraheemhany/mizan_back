import { randomBytes } from "node:crypto";

// Sending through a Gmail account with the Gmail API (HTTPS). It needs no domain of
// our own, and works where outbound SMTP is blocked (Railway's Hobby plan). The
// account is authorized once with `npm run gmail:token`, which prints the refresh token.
// Kept free of the app config, so that script can use it before any of it is set.

export type GmailAccount = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The Gmail address that authorized the app; every email is sent from it. */
  sender: string;
};

export type GmailMessage = {
  /** Shown as the sender's name; the address is always the account's. */
  fromName: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | undefined;
};

/** Google refused or couldn't be reached; `detail` is for the logs. */
export class GmailError extends Error {
  constructor(
    message: string,
    readonly detail: { status?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "GmailError";
  }
}

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TIMEOUT_MS = 10_000;

/**
 * Non-ASCII header text as RFC 2047 encoded words ("=?UTF-8?B?...?="), each at most
 * 75 characters long and never splitting a character, folded onto continuation lines.
 */
export function encodeHeaderText(value: string) {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  const words: string[] = [];
  let chunk = "";
  for (const char of clean) {
    // 45 bytes encode to 60 base64 characters: 10 + 60 + 2 = 72 per word.
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** An address on its own, without anything that could start a new header line. */
const plainAddress = (address: string) => address.replace(/[\r\n<>",;]/g, "").trim();

/** base64 in 76-character lines, as MIME bodies are written. */
const base64Lines = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

/** The email as an RFC 5322 message: text and HTML alternatives, everything UTF-8. */
export function buildMime(sender: string, mail: GmailMessage, boundary = `mizan-${randomBytes(12).toString("hex")}`) {
  const headers = [
    `From: ${encodeHeaderText(mail.fromName || "Mizan")} <${plainAddress(sender)}>`,
    `To: <${plainAddress(mail.to)}>`,
    ...(mail.replyTo ? [`Reply-To: <${plainAddress(mail.replyTo)}>`] : []),
    `Subject: ${encodeHeaderText(mail.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join("\r\n");
  return [...headers, "", part("text/plain", mail.text), part("text/html", mail.html), `--${boundary}--`, ""].join("\r\n");
}

async function post(url: string, init: RequestInit, what: string, fetchImpl: typeof fetch) {
  try {
    return await fetchImpl(url, { ...init, method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new GmailError(`Could not reach Google (${what})`, { cause });
  }
}

/**
 * A sender for one account. It keeps the access token until shortly before it
 * expires, and gets a fresh one once if Google says the one it has is no good.
 */
export function createGmailSender(account: GmailAccount, fetchImpl: typeof fetch = fetch) {
  let cached: { token: string; until: number } | null = null;

  async function accessToken() {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await post(
      GOOGLE_TOKEN_URL,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: account.clientId,
          client_secret: account.clientSecret,
          refresh_token: account.refreshToken,
          grant_type: "refresh_token",
        }),
      },
      "token",
      fetchImpl,
    );
    const body = await res.text();
    if (!res.ok) {
      // invalid_grant: the refresh token was revoked (or the app is still in "Testing",
      // where Google expires it after 7 days). Run `npm run gmail:token` again.
      throw new GmailError("Google refused the refresh token", { status: res.status, body: body.slice(0, 500) });
    }
    const { access_token: token, expires_in: seconds } = JSON.parse(body) as { access_token: string; expires_in: number };
    cached = { token, until: Date.now() + (seconds - 60) * 1000 };
    return token;
  }

  async function sendOnce(raw: string) {
    return post(
      SEND_URL,
      { headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw }) },
      "send",
      fetchImpl,
    );
  }

  return async function send(mail: GmailMessage): Promise<void> {
    const raw = Buffer.from(buildMime(account.sender, mail), "utf8").toString("base64url");
    let res = await sendOnce(raw);
    if (res.status === 401) {
      cached = null;
      res = await sendOnce(raw);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GmailError("Gmail refused the email", { status: res.status, body: body.slice(0, 500) });
    }
  };
}
