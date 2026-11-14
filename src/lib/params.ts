import { z } from "zod";
import { AppError } from "./errors.js";

const uuid = z.uuid();

/**
 * Reads an id from the URL. A malformed id gets the same 404 as a missing one,
 * so callers cannot tell "bad id" from "exists in another company".
 */
export function parseId(value: unknown, resource = "Resource") {
  const result = uuid.safeParse(value);
  if (!result.success) throw notFound(resource);
  return result.data;
}

export const notFound = (resource = "Resource") => new AppError(404, "NOT_FOUND", `${resource} not found`);
