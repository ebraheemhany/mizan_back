import { Router, type Request } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { listRecurringQuerySchema, recurringSchema } from "./recurring.schemas.js";
import * as recurring from "./recurring.service.js";

export function createRecurringRouter() {
  const router = Router();
  router.use(authenticate);

  // Every role can see the recurring invoices; changing them makes invoices, so it
  // needs the same permission as issuing one.
  const write = requirePermission("issueInvoices");
  const id = (req: Request) => parseId(req.params["id"], "Recurring invoice");

  router.get("/", async (req, res) => {
    res.json(await recurring.listRecurring(req.user!.companyId, parseQuery(listRecurringQuerySchema, req.query)));
  });

  router.post("/", write, validateBody(recurringSchema), async (req, res) => {
    res.status(201).json({ template: await recurring.createRecurring(req.user!, req.body) });
  });

  router.get("/:id", async (req, res) => {
    res.json({ template: await recurring.getRecurring(req.user!.companyId, id(req)) });
  });

  router.patch("/:id", write, validateBody(recurringSchema), async (req, res) => {
    res.json({ template: await recurring.updateRecurring(req.user!, id(req), req.body) });
  });

  router.post("/:id/pause", write, async (req, res) => {
    res.json({ template: await recurring.pauseRecurring(req.user!, id(req)) });
  });

  router.post("/:id/resume", write, async (req, res) => {
    res.json({ template: await recurring.resumeRecurring(req.user!, id(req)) });
  });

  router.delete("/:id", write, async (req, res) => {
    await recurring.deleteRecurring(req.user!, id(req));
    res.status(204).end();
  });

  return router;
}
