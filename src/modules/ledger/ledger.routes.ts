import { Router, type Request } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import * as periods from "./ledger.periods.js";
import {
  accountSchema,
  entrySchema,
  listEntriesQuerySchema,
  monthBodySchema,
  trialBalanceQuerySchema,
  updateAccountSchema,
} from "./ledger.schemas.js";
import * as ledger from "./ledger.service.js";

export function createLedgerRouter() {
  const router = Router();
  // The books are for the owner and the accountant (reading included).
  router.use(authenticate, requirePermission("ledger"));

  const accountId = (req: Request) => parseId(req.params["id"], "Account");
  const entryId = (req: Request) => parseId(req.params["id"], "Journal entry");

  // Chart of accounts
  router.get("/accounts", async (req, res) => {
    res.json({ accounts: await ledger.listAccounts(req.user!.companyId) });
  });
  router.post("/accounts", validateBody(accountSchema), async (req, res) => {
    res.status(201).json({ account: await ledger.createAccount(req.user!.companyId, req.body) });
  });
  router.patch("/accounts/:id", validateBody(updateAccountSchema), async (req, res) => {
    res.json({ account: await ledger.updateAccount(req.user!.companyId, accountId(req), req.body) });
  });
  router.delete("/accounts/:id", async (req, res) => {
    await ledger.deleteAccount(req.user!.companyId, accountId(req));
    res.status(204).end();
  });

  // Journal
  router.get("/entries", async (req, res) => {
    res.json(await ledger.listEntries(req.user!.companyId, parseQuery(listEntriesQuerySchema, req.query)));
  });
  router.post("/entries", validateBody(entrySchema), async (req, res) => {
    res.status(201).json({ entry: await ledger.createEntry(req.user!, req.body) });
  });
  router.post("/entries/post-drafts", validateBody(monthBodySchema), async (req, res) => {
    res.json(await ledger.postDrafts(req.user!, req.body.month));
  });
  router.get("/entries/:id", async (req, res) => {
    res.json({ entry: await ledger.getEntry(req.user!.companyId, entryId(req)) });
  });
  router.patch("/entries/:id", validateBody(entrySchema), async (req, res) => {
    res.json({ entry: await ledger.updateEntry(req.user!, entryId(req), req.body) });
  });
  router.post("/entries/:id/post", async (req, res) => {
    res.json({ entry: await ledger.postEntry(req.user!, entryId(req)) });
  });
  router.delete("/entries/:id", async (req, res) => {
    await ledger.deleteEntry(req.user!, entryId(req));
    res.status(204).end();
  });

  // Trial balance
  router.get("/trial-balance", async (req, res) => {
    const { month } = parseQuery(trialBalanceQuerySchema, req.query);
    res.json(await ledger.trialBalance(req.user!.companyId, month));
  });

  // Closing periods
  router.get("/periods", async (req, res) => {
    res.json(await periods.getPeriods(req.user!.companyId));
  });
  router.post("/periods/close", validateBody(monthBodySchema), async (req, res) => {
    res.json(await periods.closePeriod(req.user!.companyId, req.body.month));
  });
  // Opening a closed month again is for the owner only.
  router.post("/periods/reopen", requirePermission("reopenPeriods"), async (req, res) => {
    res.json(await periods.reopenPeriod(req.user!.companyId));
  });

  return router;
}
