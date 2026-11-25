import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { AppError } from "./errors.js";
import { createGmailSender, GmailError } from "./gmail.js";
import { logger } from "./logger.js";

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Shown as the sender's name (the address is always MAIL_FROM's, or the Gmail account's).
   * Unset: MAIL_FROM's name, Mizan. Customer emails keep it so the inbox shows they come
   * through Mizan; the company is named in the subject and at the top of the email.
   */
  fromName?: string;
  /** Where the recipient's answer goes (e.g. the user who sent an invoice). */
  replyTo?: string;
  /** What kind of email this is (letters, digits, - and _), to tell them apart in Resend. */
  tag: string;
};

/**
 * Emails "sent" while testing, oldest first. Tests read and clear it; setting
 * `fail` makes the next sends fail, as if Resend were down.
 */
export const testMail = { outbox: [] as Mail[], fail: false };

/** Delivery failed (Resend or Gmail refused it or couldn't be reached). */
export const mailFailed = () =>
  new AppError(502, "EMAIL_FAILED", "The email couldn't be sent right now; try again in a few minutes");

const RESEND_URL = "https://api.resend.com/emails";

/** The Gmail account, when it's the one sending (no Resend key, all GMAIL_* values set). */
const gmail =
  !config.RESEND_API_KEY &&
  config.GMAIL_CLIENT_ID &&
  config.GMAIL_CLIENT_SECRET &&
  config.GMAIL_REFRESH_TOKEN &&
  config.GMAIL_SENDER
    ? createGmailSender({
        clientId: config.GMAIL_CLIENT_ID,
        clientSecret: config.GMAIL_CLIENT_SECRET,
        refreshToken: config.GMAIL_REFRESH_TOKEN,
        sender: config.GMAIL_SENDER,
      })
    : null;

/** MAIL_FROM's display name ("Mizan" in `Mizan <x@y>`), for Gmail where the address is the account's. */
const defaultName = config.MAIL_FROM.match(/^\s*"?([^"<]*?)"?\s*</)?.[1]?.trim() || "Mizan";

/** MAIL_FROM's address with another display name ("شركة النور" <billing@mizan.app>). */
function fromHeader(name?: string) {
  if (!name) return config.MAIL_FROM;
  const address = config.MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? config.MAIL_FROM;
  // Quotes, brackets and line breaks would break the header.
  const clean = name.replace(/["<>\\\r\n]/g, "").trim().slice(0, 80);
  return clean ? `"${clean}" <${address}>` : config.MAIL_FROM;
}

/** Sends one email, or throws EMAIL_FAILED. */
export async function sendMail(mail: Mail): Promise<void> {
  if (config.NODE_ENV === "test") {
    if (testMail.fail) throw mailFailed();
    testMail.outbox.push(mail);
    return;
  }
  if (gmail) {
    try {
      await gmail({ fromName: mail.fromName ?? defaultName, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: mail.replyTo });
    } catch (err) {
      const { status, body } = err instanceof GmailError ? err.detail : {};
      logger.error({ err, status, body, tag: mail.tag }, "Gmail could not send an email");
      throw mailFailed();
    }
    return;
  }
  if (!config.RESEND_API_KEY) {
    if (config.NODE_ENV === "production") {
      logger.error({ tag: mail.tag }, "No email service is set (RESEND_API_KEY or the GMAIL_* values): email not sent");
      throw mailFailed();
    }
    await writeToOutbox(mail);
    return;
  }

  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromHeader(mail.fromName),
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        reply_to: mail.replyTo,
        tags: [{ name: "kind", value: mail.tag }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.error({ err, tag: mail.tag }, "Could not reach Resend");
    throw mailFailed();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body: body.slice(0, 500), tag: mail.tag }, "Resend refused an email");
    throw mailFailed();
  }
}

/** Sends, and reports failure as false instead of throwing (it is already logged). */
export async function trySendMail(mail: Mail): Promise<boolean> {
  try {
    await sendMail(mail);
    return true;
  } catch (err) {
    if (!(err instanceof AppError)) logger.error({ err, tag: mail.tag }, "Email failed");
    return false;
  }
}

/** Development without a key: each email becomes an .html file to open in the browser. */
async function writeToOutbox(mail: Mail) {
  const dir = path.resolve(config.MAIL_OUTBOX_DIR);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = mail.to.replace(/[^a-z0-9@._-]/gi, "_");
  const file = path.join(dir, `${stamp}-${mail.tag}-${safeTo}.html`);
  const head = `<!--\nFrom: ${fromHeader(mail.fromName)}\nTo: ${mail.to}\nReply-To: ${mail.replyTo ?? ""}\nSubject: ${mail.subject}\n-->\n`;
  await writeFile(file, head + mail.html, "utf8");
  logger.info({ to: mail.to, subject: mail.subject, file }, "Email written to the outbox (no email service set)");
}
