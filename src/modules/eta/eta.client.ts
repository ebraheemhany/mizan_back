// Talking to ETA's e-invoicing API (https://sdk.invoicing.eta.gov.eg/einvoicingapi/):
// a token per company (client credentials, kept for its hour), submitting a document,
// following its submission, its details, and asking for a cancellation.
//
// TLS: preprod is served under ETA's own root CA (trusted for preprod only); production
// needs legacy renegotiation (Odoo's note on "gravely outdated ETA production servers").
// The URLs can be pointed elsewhere (ETA_<ENV>_ID_URL / _API_URL / _PORTAL_URL), e.g. at
// the mock server in the tests.
import http from "node:http";
import https from "node:https";
import { constants } from "node:crypto";
import { rootCertificates } from "node:tls";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { ETA_PREPROD_ROOT_CA } from "./eta.codes.js";

export type EtaEnv = "preprod" | "production";
export type EtaCredentials = { environment: EtaEnv; clientId: string; clientSecret: string };

const DEFAULTS: Record<EtaEnv, { id: string; api: string; portal: string }> = {
  preprod: {
    id: "https://id.preprod.eta.gov.eg",
    api: "https://api.preprod.invoicing.eta.gov.eg",
    portal: "https://preprod.invoicing.eta.gov.eg",
  },
  production: {
    id: "https://id.eta.gov.eg",
    api: "https://api.invoicing.eta.gov.eg",
    portal: "https://invoicing.eta.gov.eg",
  },
};

/** ETA's addresses for an environment (read when used, so tests can point them at a mock). */
export function etaUrls(env: EtaEnv) {
  const key = env === "preprod" ? "PREPROD" : "PROD";
  const pick = (name: string, fallback: string) => (process.env[`ETA_${key}_${name}_URL`] || fallback).replace(/\/+$/, "");
  return { id: pick("ID", DEFAULTS[env].id), api: pick("API", DEFAULTS[env].api), portal: pick("PORTAL", DEFAULTS[env].portal) };
}

/** Where anyone with the link can see the document at ETA. */
export const etaPublicUrl = (env: EtaEnv, uuid: string, longId: string) => `${etaUrls(env).portal}/documents/${uuid}/share/${longId}`;

const agents: Record<EtaEnv, https.Agent> = {
  preprod: new https.Agent({ keepAlive: true, ca: [...rootCertificates, ETA_PREPROD_ROOT_CA] }),
  production: new https.Agent({ keepAlive: true, secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT }),
};

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: any };

function call(env: EtaEnv, url: string, init: { method: string; headers?: Record<string, string>; body?: string }, timeoutMs = 30_000) {
  return new Promise<Reply>((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const req = client.request(
      target,
      {
        method: init.method,
        headers: { Accept: "application/json", "Accept-Language": "ar", ...init.headers },
        ...(target.protocol === "https:" ? { agent: agents[env] } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = { raw: text.slice(0, 500) };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("ETA request timed out")));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** ETA couldn't be reached, or answered with a server error: try again later. */
const unreachable = (detail: string) => new AppError(502, "ETA_UNREACHABLE", `The tax authority's system didn't answer (${detail})`);

async function send(env: EtaEnv, url: string, init: Parameters<typeof call>[2], timeoutMs?: number) {
  let reply: Reply;
  try {
    reply = await call(env, url, init, timeoutMs);
  } catch (err) {
    logger.warn({ err, url }, "ETA request failed");
    throw unreachable(err instanceof Error ? err.message : "network");
  }
  if (reply.status === 429) {
    throw new AppError(503, "ETA_BUSY", "The tax authority's system asks to wait a little", {
      retryAfterSeconds: Number(reply.headers["retry-after"] ?? 10) || 10,
    });
  }
  if (reply.status >= 500) throw unreachable(`HTTP ${reply.status}`);
  return reply;
}

// ---------------------------------------------------------------------------
// Token: one per (environment, client id), renewed a few minutes before its hour is up
// ---------------------------------------------------------------------------

const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function etaToken(creds: EtaCredentials, { fresh = false } = {}) {
  const key = `${creds.environment}:${creds.clientId}`;
  const cached = tokens.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const reply = await send(creds.environment, `${etaUrls(creds.environment).id}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "InvoicingAPI" }).toString(),
  });
  const token = reply.body?.access_token;
  if (reply.status !== 200 || typeof token !== "string") {
    tokens.delete(key);
    throw new AppError(400, "ETA_BAD_CREDENTIALS", "The tax authority didn't accept the client id and secret", {
      reason: String(reply.body?.error ?? reply.status),
    });
  }
  tokens.set(key, { token, expiresAt: Date.now() + (Number(reply.body?.expires_in) || 3600) * 1000 });
  return token;
}

/** A call with the company's token; if ETA says the token is no longer good, once more with a new one. */
async function authed(creds: EtaCredentials, url: string, init: { method: string; body?: string }, timeoutMs?: number) {
  const go = async (fresh: boolean) =>
    send(
      creds.environment,
      url,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${await etaToken(creds, { fresh })}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      },
      timeoutMs,
    );
  const reply = await go(false);
  // The same bytes again: ETA treats an identical submission as a duplicate, never a second invoice.
  return reply.status === 401 ? go(true) : reply;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** One problem ETA reported, flattened: its code, message (Arabic when given) and where. */
export type EtaProblem = { code: string; message: string; target?: string; path?: string };

/** ETA's error objects (submission errors, validation steps) → a flat list of the innermost problems. */
export function etaProblems(error: unknown): EtaProblem[] {
  if (!error || typeof error !== "object") return [];
  const e = error as Record<string, any>;
  const inner = [e.details, e.innerError, e.innerErrors].find((v) => Array.isArray(v) && v.length) as unknown[] | undefined;
  if (inner) return inner.flatMap(etaProblems);
  const code = String(e.code ?? e.errorCode ?? "error");
  const message = String(e.errorAr ?? e.messageAr ?? e.message ?? e.error ?? code);
  const target = e.target ?? e.propertyName;
  const path = e.propertyPath;
  return [{ code, message, ...(target ? { target: String(target) } : {}), ...(path ? { path: String(path) } : {}) }];
}

export type EtaSubmitResult =
  | { accepted: true; submissionId: string; uuid: string; longId: string }
  | { accepted: false; submissionId: string | null; problems: EtaProblem[] };

/**
 * Sends ONE document (as its exact JSON text, which its signature/hash covers). A 422 is
 * ETA's duplicate guard: the same document was sent in the last 10 minutes.
 */
export async function etaSubmit(creds: EtaCredentials, documentJson: string): Promise<EtaSubmitResult> {
  const reply = await authed(creds, `${etaUrls(creds.environment).api}/api/v1.0/documentsubmissions`, {
    method: "POST",
    body: `{"documents":[${documentJson}]}`,
  }, 60_000);
  if (reply.status === 422) {
    throw new AppError(409, "ETA_DUPLICATE", "This document was sent to the tax authority a few minutes ago", {
      retryAfterSeconds: Number(reply.headers["retry-after"] ?? 600) || 600,
    });
  }
  const body = reply.body ?? {};
  // The SDK names it submissionUUID; working integrations read submissionId.
  const submissionId: string | null = body.submissionId ?? body.submissionUUID ?? null;
  if (reply.status === 202 || reply.status === 200) {
    const accepted = (body.acceptedDocuments ?? [])[0];
    if (accepted?.uuid && submissionId) return { accepted: true, submissionId, uuid: accepted.uuid, longId: accepted.longId ?? "" };
    const rejected = (body.rejectedDocuments ?? [])[0];
    return { accepted: false, submissionId, problems: etaProblems(rejected?.error ?? rejected) };
  }
  if (reply.status === 403) {
    return { accepted: false, submissionId: null, problems: etaProblems(body.error ?? { code: "Forbidden", message: "Forbidden" }) };
  }
  // 400 BadStructure / MaximumSizeExceeded and the like.
  return { accepted: false, submissionId: null, problems: etaProblems(body.error ?? { code: `HTTP${reply.status}`, message: "Rejected" }) };
}

export type EtaDocStatus = "submitted" | "valid" | "invalid" | "rejected" | "cancelled";

/** ETA's status words → ours. */
export function etaStatusOf(word: unknown): EtaDocStatus | null {
  const w = String(word ?? "").toLowerCase().replace(/\s+/g, "");
  if (w === "valid") return "valid";
  if (w === "invalid") return "invalid";
  if (w === "rejected") return "rejected";
  if (w === "cancelled" || w === "canceled") return "cancelled";
  if (w === "submitted" || w === "inprogress") return "submitted";
  return null;
}

/** The status of one document in a submission (null while ETA hasn't listed it yet). */
export async function etaSubmissionStatus(creds: EtaCredentials, submissionId: string, uuid: string) {
  const reply = await authed(creds, `${etaUrls(creds.environment).api}/api/v1.0/documentsubmissions/${encodeURIComponent(submissionId)}?pageNo=1&pageSize=100`, {
    method: "GET",
  });
  if (reply.status === 404) return null;
  const summary = ((reply.body?.documentSummary ?? []) as { uuid?: string; status?: string }[]).find((d) => d.uuid === uuid);
  return summary ? etaStatusOf(summary.status) : null;
}

/** A document's status and, when it failed ETA's checks, the reasons. */
export async function etaDocumentDetails(creds: EtaCredentials, uuid: string) {
  const reply = await authed(creds, `${etaUrls(creds.environment).api}/api/v1.0/documents/${encodeURIComponent(uuid)}/details`, { method: "GET" });
  if (reply.status === 404) return null;
  const body = reply.body ?? {};
  const steps = (body.validationResults?.validationSteps ?? []) as { status?: string; error?: unknown; name?: string }[];
  const problems = steps.filter((s) => etaStatusOf(s.status) === "invalid").flatMap((s) => etaProblems(s.error ?? { code: s.name ?? "Invalid", message: s.name ?? "Invalid" }));
  return {
    status: etaStatusOf(body.status),
    problems,
    cancelRequested: Boolean(body.cancelRequestDate),
    total: typeof body.document?.totalAmount === "number" ? body.document.totalAmount : null,
  };
}

/** Asks ETA to cancel a document; it applies unless the buyer declines in time. */
export async function etaCancel(creds: EtaCredentials, uuid: string, reason: string) {
  const reply = await authed(creds, `${etaUrls(creds.environment).api}/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`, {
    method: "PUT",
    body: JSON.stringify({ status: "cancelled", reason }),
  });
  if (reply.status === 200 || reply.status === 204) return;
  const code = String(reply.body?.error?.code ?? `HTTP${reply.status}`);
  const known: Record<string, [number, string]> = {
    OperationPeriodOver: [409, "ETA_CANCEL_PERIOD_OVER"],
    ActiveReferencingDocuments: [409, "ETA_CANCEL_HAS_CREDIT_NOTES"],
    IncorrectState: [409, "ETA_CANCEL_WRONG_STATE"],
  };
  const [status, ours] = known[code] ?? [409, "ETA_CANCEL_REFUSED"];
  throw new AppError(status, ours, "The tax authority refused the cancellation", { etaCode: code, problems: etaProblems(reply.body?.error) });
}
