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
