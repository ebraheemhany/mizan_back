import { Router, type Request } from "express";
import { notFound } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import type { AuthRateLimiters } from "../../middleware/rate-limit.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { createQuoteSchema, emailQuoteSchema, listQuotesQuerySchema, updateQuoteSchema } from "./quotes.schemas.js";
import * as quotes from "./quotes.service.js";

export function createQuotesRouter(limit: AuthRateLimiters) {
  const router = Router();
  router.use(authenticate);

  // Every role can read quotes. Writing them needs the "quotes" permission; deleting
  // one that was sent is for the owner only (checked in the service). Converting a
  // quote happens through POST /api/invoices (fromQuote), which needs issueInvoices.
  const write = requirePermission("quotes");
  const ref = (req: Request) => quotes.parseQuoteRef(req.params["ref"]);

  router.get("/", async (req, res) => {
    res.json(await quotes.listQuotes(req.user!.companyId, parseQuery(listQuotesQuerySchema, req.query)));
  });

  // Fixed paths first, so they aren't mistaken for a quote reference.
  router.get("/stats", async (req, res) => {
    res.json({ stats: await quotes.quoteStats(req.user!.companyId) });
  });

  router.post("/", write, validateBody(createQuoteSchema), async (req, res) => {
    res.status(201).json({ quote: await quotes.createQuote(req.user!, req.body) });
  });

  // :ref is the quote id or its number (/api/quotes/212).
  router.get("/:ref", async (req, res) => {
    res.json({ quote: await quotes.getQuote(req.user!.companyId, ref(req)) });
  });

  router.patch("/:ref", write, validateBody(updateQuoteSchema), async (req, res) => {
    res.json({ quote: await quotes.updateQuote(req.user!, ref(req), req.body) });
  });

  router.post("/:ref/send", write, async (req, res) => {
    res.json({ quote: await quotes.sendQuote(req.user!, ref(req)) });
  });

  router.post("/:ref/email", write, limit.customerEmail, validateBody(emailQuoteSchema), async (req, res) => {
    res.json({ quote: await quotes.emailQuote(req.user!, ref(req), req.body) });
  });

  router.post("/:ref/accept", write, async (req, res) => {
    res.json({ quote: await quotes.decideQuote(req.user!, ref(req), "accepted") });
  });

  router.post("/:ref/reject", write, async (req, res) => {
    res.json({ quote: await quotes.decideQuote(req.user!, ref(req), "rejected") });
  });

  router.post("/:ref/duplicate", write, async (req, res) => {
    res.status(201).json({ quote: await quotes.duplicateQuote(req.user!, ref(req)) });
  });

  router.delete("/:ref", write, async (req, res) => {
    await quotes.deleteQuote(req.user!, ref(req));
    res.status(204).end();
  });

  return router;
}

/**
 * /api/public/quotes/:token — the link sent to the customer, no login. They can
 * view the quote and accept or reject it while it is still valid.
 */
export function createPublicQuotesRouter(limit: AuthRateLimiters) {
  const router = Router();
  const token = (req: Request) => {
    const value = String(req.params["token"]);
    if (!/^[\w-]{20,100}$/.test(value)) throw notFound("Quote");
    return value;
  };

  router.get("/:token", async (req, res) => {
    res.json({ quote: await quotes.getPublicQuote(token(req)) });
  });

  router.post("/:token/accept", limit.publicQuoteAnswer, async (req, res) => {
    res.json({ quote: await quotes.answerPublicQuote(token(req), "accepted") });
  });

  router.post("/:token/reject", limit.publicQuoteAnswer, async (req, res) => {
    res.json({ quote: await quotes.answerPublicQuote(token(req), "rejected") });
  });

  return router;
}
