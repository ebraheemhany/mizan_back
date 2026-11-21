import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/**
 * Per-request facts the audit log needs deep inside the services (the caller's
 * IP and who is signed in), without passing them through every function.
 * Outside a request (the recurring-invoice job, tests calling services
 * directly) there is no store: the audit log records "the system".
 */
type Store = { ip: string | null; user?: { id: string; name: string } };

const storage = new AsyncLocalStorage<Store>();

export const requestContext: RequestHandler = (req, _res, next) => {
  storage.run({ ip: req.ip ?? null }, next);
};

/** Called by authenticate once it knows who is calling. */
export function setRequestUser(user: { id: string; name: string }) {
  const store = storage.getStore();
  if (store) store.user = user;
}

export const currentRequest = () => storage.getStore();
