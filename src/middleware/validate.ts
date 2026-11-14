import type { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";

export const validateBody =
  (schema: z.ZodType): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request body", {
        fieldErrors: z.flattenError(result.error).fieldErrors,
      });
    }
    req.body = result.data;
    next();
  };

/**
 * Reads the query string (?page=2&q=...) with a schema. Express 5 doesn't allow
 * replacing req.query, so handlers call this and use what it returns.
 */
export function parseQuery<T extends z.ZodType>(schema: T, query: unknown): z.infer<T> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid query parameters", {
      fieldErrors: z.flattenError(result.error).fieldErrors,
    });
  }
  return result.data;
}
