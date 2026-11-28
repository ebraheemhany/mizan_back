import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";
import { reportError } from "../lib/error-alerts.js";

export const notFound: RequestHandler = (req) => {
  throw new AppError(404, "NOT_FOUND", `Route ${req.method} ${req.path} not found`);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
    return;
  }

  // Malformed JSON body (thrown by express.json()).
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    return;
  }

  // A body over the route's limit (a CSV import or an uploaded file too big).
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: { code: "FILE_TOO_LARGE", message: "The file or request is too large" } });
    return;
  }

  req.log.error({ err }, "Unhandled error");
  void reportError(err, { where: `${req.method} ${req.originalUrl.split("?")[0]}`, userId: req.user?.id, companyId: req.user?.companyId });
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
};
