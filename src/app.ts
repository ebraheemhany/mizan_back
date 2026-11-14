import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFound } from "./middleware/error-handler.js";
import { createAuthRateLimiters } from "./middleware/rate-limit.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createCustomersRouter } from "./modules/customers/customers.routes.js";
import { createDirectoryRouter } from "./modules/users/directory.routes.js";
import { createInvitationsRouter } from "./modules/invitations/invitations.routes.js";
import { createUsersRouter } from "./modules/users/users.routes.js";

type AppOptions = {
  /** Turn rate limiting off (used by tests that make many requests from one IP). */
  rateLimit?: boolean;
};

export function createApp({ rateLimit = true }: AppOptions = {}) {
  const app = express();

  // Behind a proxy (Nginx, Railway, Render...) this makes req.ip the real client IP
  // instead of the proxy's, so rate limits apply per user and not to everyone at once.
  app.set("trust proxy", config.TRUST_PROXY);

  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN }));
  // 1mb fits a CSV import of 1000 customers; the default (100kb) does not.
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const limiters = createAuthRateLimiters(rateLimit);
  app.use("/api/auth", createAuthRouter(limiters));
  app.use("/api/users", createUsersRouter());
  app.use("/api/invitations", createInvitationsRouter(limiters));
  app.use("/api/team-members", createDirectoryRouter());
  app.use("/api/customers", createCustomersRouter());

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
