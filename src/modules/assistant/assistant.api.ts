// How the assistant does things: it calls Mizan's own API over HTTP with the signed-in
// user's token, exactly like the app does. Permissions, plan limits, validation and the
// audit log all apply, and nothing here can do more than that user could by hand.
import { config } from "../../config.js";
import type { HttpMethod } from "./assistant.catalog.js";

export type ApiCall = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null> | undefined;
  body?: unknown;
};

export type ApiResult = { ok: boolean; status: number; data: unknown };

/** Who the call is made as: the bearer token of the request to the assistant, and their IP. */
export type Caller = { token: string; ip: string | null };

let baseUrl: string | null = null;

/** Tests run the app on a port of their own. */
export function setSelfUrlForTests(url: string | null) {
  baseUrl = url;
}

const selfUrl = () => baseUrl ?? `http://127.0.0.1:${config.PORT}`;

export async function callMizan(call: ApiCall, caller: Caller): Promise<ApiResult> {
  const url = new URL(call.path, selfUrl());
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const hasBody = call.method !== "GET" && call.method !== "DELETE" && call.body !== undefined;
  let res: Response;
  try {
    res = await fetch(url, {
      method: call.method,
      headers: {
        Authorization: `Bearer ${caller.token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        // The user's own IP for the audit log and rate limits (read only behind a trusted proxy).
        ...(caller.ip ? { "X-Forwarded-For": caller.ip } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, data: { error: { code: "NETWORK_ERROR", message: "Mizan's API did not answer" } } };
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 2000);
    }
  }
  return { ok: res.ok, status: res.status, data: res.status === 204 ? { done: true } : data };
}
