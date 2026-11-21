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
import { createDashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { createExpensesRouter } from "./modules/expenses/expenses.routes.js";
import { createInvoicesRouter, createPublicInvoicesRouter } from "./modules/invoices/invoices.routes.js";
import { createPaymentsRouter } from "./modules/payments/payments.routes.js";
import { createProductsRouter } from "./modules/products/products.routes.js";
import { createPublicQuotesRouter, createQuotesRouter } from "./modules/quotes/quotes.routes.js";
import { createReportsRouter } from "./modules/reports/reports.routes.js";
import { createSettingsRouter } from "./modules/settings/settings.routes.js";
import { createTasksRouter } from "./modules/tasks/tasks.routes.js";
import { createRecurringRouter } from "./modules/recurring/recurring.routes.js";
import { createLedgerRouter } from "./modules/ledger/ledger.routes.js";
import { createAuditRouter } from "./modules/audit/audit.routes.js";
import { createDealsRouter } from "./modules/deals/deals.routes.js";
import { createPublicLogosRouter } from "./modules/files/files.routes.js";
import { createBillingRouter, createPaymobWebhookRouter, createTestCheckoutRouter } from "./modules/billing/billing.routes.js";
import { requestContext } from "./lib/request-context.js";
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
  // The caller's IP (and, once signed in, who they are) for the audit log.
  app.use(requestContext);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const limiters = createAuthRateLimiters(rateLimit);
  app.use("/api/auth", createAuthRouter(limiters));
  app.use("/api/users", createUsersRouter());
  app.use("/api/invitations", createInvitationsRouter(limiters));
  app.use("/api/team-members", createDirectoryRouter());
  app.use("/api/customers", createCustomersRouter());
  app.use("/api/products", createProductsRouter());
  app.use("/api/settings", createSettingsRouter());
  app.use("/api/invoices", createInvoicesRouter(limiters));
  app.use("/api/public/invoices", createPublicInvoicesRouter());
  app.use("/api/payments", createPaymentsRouter());
  app.use("/api/dashboard", createDashboardRouter());
  app.use("/api/expenses", createExpensesRouter());
  app.use("/api/reports", createReportsRouter());
  app.use("/api/tasks", createTasksRouter());
  app.use("/api/recurring", createRecurringRouter());
  app.use("/api/ledger", createLedgerRouter());
  app.use("/api/audit", createAuditRouter());
  app.use("/api/deals", createDealsRouter());
  app.use("/api/public/logos", createPublicLogosRouter());
  // The test checkout before the billing router (that one needs a login).
  app.use("/api/billing/test-checkout", createTestCheckoutRouter());
  app.use("/api/billing", createBillingRouter());
  app.use("/api/public/paymob", createPaymobWebhookRouter());
  app.use("/api/quotes", createQuotesRouter(limiters));
  app.use("/api/public/quotes", createPublicQuotesRouter(limiters));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
