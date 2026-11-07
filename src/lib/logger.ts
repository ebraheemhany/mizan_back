import { pino } from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  // Never write bearer tokens or passwords to the logs.
  redact: ["req.headers.authorization", "*.password", "*.currentPassword", "*.newPassword", "*.accessToken", "*.refreshToken"],
});
