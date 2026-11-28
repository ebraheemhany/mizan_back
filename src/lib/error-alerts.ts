// Tells Mizan's own staff (PLATFORM_ADMIN_EMAILS) by email when something breaks on the
// server: an unexpected error in a request, a background job that failed, a promise
// nobody caught. Free (it goes through the app's own email), and kept quiet: the same
// error is emailed once an hour at most, and no more than a few dozen emails a day.
import { config } from "../config.js";
import { logger } from "./logger.js";
import { sendMail } from "./mailer.js";

const HOUR_MS = 60 * 60 * 1000;
const MAX_PER_DAY = 30;

/** When each error (by its signature) was last emailed. */
const lastSent = new Map<string, number>();
let day = "";
let sentToday = 0;

export type ErrorContext = {
  /** Where it happened: "GET /api/invoices/1044", "job: subscriptions"... */
  where: string;
  userId?: string | undefined;
  companyId?: string | undefined;
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The same error from the same place counts once: its message and the first line of its stack. */
function signature(err: Error, where: string) {
  const frame = err.stack?.split("\n").find((line) => line.trim().startsWith("at ")) ?? "";
  return `${where.replace(/[0-9a-f-]{36}|\d+/gi, ":id")}|${err.name}|${err.message.slice(0, 200)}|${frame.trim()}`;
}

/** Emails the alert if it is new enough; never throws. */
export async function reportError(error: unknown, context: ErrorContext) {
  if (config.NODE_ENV === "test" && !alertsInTests.on) return;
  const to = config.PLATFORM_ADMIN_EMAILS;
  if (to.length === 0) return;
  const err = error instanceof Error ? error : new Error(String(error));

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    sentToday = 0;
  }
  const key = signature(err, context.where);
  if ((lastSent.get(key) ?? 0) > now - HOUR_MS || sentToday >= MAX_PER_DAY) return;
  lastSent.set(key, now);
  sentToday++;

  const lines = [
    `Where: ${context.where}`,
    `When: ${new Date(now).toISOString()} (UTC)`,
    ...(context.companyId ? [`Company: ${context.companyId}`] : []),
    ...(context.userId ? [`User: ${context.userId}`] : []),
    `Error: ${err.name}: ${err.message}`,
    "",
    (err.stack ?? "").split("\n").slice(0, 12).join("\n"),
  ];
  const text = `${lines.join("\n")}\n\nThe same error is emailed again only after an hour. Railway's logs have the rest.`;
  try {
    for (const address of to) {
      await sendMail({
        to: address,
        subject: `Mizan error: ${err.message.slice(0, 80)} (${context.where.slice(0, 60)})`,
        text,
        html: `<pre style="font:13px/1.5 monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        tag: "error-alert",
      });
    }
  } catch (mailError) {
    logger.warn({ err: mailError }, "error alert email not sent");
  }
}

/** Tests turn alerts on to check them (they are off in tests otherwise). */
export const alertsInTests = { on: false };

/** Forgets what was sent (tests). */
export function resetErrorAlerts() {
  lastSent.clear();
  sentToday = 0;
  day = "";
}
