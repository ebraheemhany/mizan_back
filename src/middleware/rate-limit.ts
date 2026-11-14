import type { Request, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

const MINUTE = 60 * 1000;

// Groups IPv6 addresses by /56 subnet, so one client cannot dodge the limit by
// rotating through the addresses it owns.
const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");

type LimiterOptions = {
  windowMs: number;
  limit: number;
  key: (req: Request) => string;
  /** Count only failed requests (status >= 400), so normal use is never blocked. */
  onlyFailures: boolean;
};

function createLimiter({ windowMs, limit, key, onlyFailures }: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: key,
    skipSuccessfulRequests: onlyFailures,
    // Sends RateLimit / RateLimit-Policy headers, and Retry-After once blocked.
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res, next) => {
      const retryAfterSeconds = Number(res.getHeader("Retry-After")) || Math.ceil(windowMs / 1000);
      next(
        new AppError(429, "TOO_MANY_REQUESTS", "Too many attempts, please try again later", {
          retryAfterSeconds,
        }),
      );
    },
  });
}

const passThrough: RequestHandler = (_req, _res, next) => next();

export type AuthRateLimiters = {
  /** Wrong passwords for one email from one IP. */
  loginPerAccount: RequestHandler;
  /** Wrong passwords from one IP across any emails (stops trying many accounts). */
  loginPerIp: RequestHandler;
  /** New accounts from one IP. */
  register: RequestHandler;
  /** Wrong current passwords for one logged-in user. Must run after `authenticate`. */
  changePassword: RequestHandler;
  /** Bad invite tokens from one IP (public preview/accept endpoints). */
  invitationToken: RequestHandler;
};

/**
 * Counters live in this process's memory: they reset on restart and are not
 * shared between instances. Move to a shared store (e.g. Redis) before running
 * more than one server instance.
 */
export function createAuthRateLimiters(enabled = true): AuthRateLimiters {
  if (!enabled) {
    return {
      loginPerAccount: passThrough,
      loginPerIp: passThrough,
      register: passThrough,
      changePassword: passThrough,
      invitationToken: passThrough,
    };
  }

  return {
    loginPerAccount: createLimiter({
      windowMs: 15 * MINUTE,
      limit: 10,
      onlyFailures: true,
      // Runs after validation, so the email is already trimmed and lowercased.
      key: (req) => `login:${clientIp(req)}:${String(req.body?.email)}`,
    }),
    loginPerIp: createLimiter({
      windowMs: 15 * MINUTE,
      limit: 50,
      onlyFailures: true,
      key: (req) => `login-ip:${clientIp(req)}`,
    }),
    register: createLimiter({
      windowMs: 60 * MINUTE,
      limit: 5,
      onlyFailures: false,
      key: (req) => `register:${clientIp(req)}`,
    }),
    changePassword: createLimiter({
      windowMs: 15 * MINUTE,
      limit: 5,
      onlyFailures: true,
      key: (req) => `change-password:${req.user?.id ?? clientIp(req)}`,
    }),
    invitationToken: createLimiter({
      windowMs: 15 * MINUTE,
      limit: 20,
      onlyFailures: true,
      key: (req) => `invitation:${clientIp(req)}`,
    }),
  };
}
