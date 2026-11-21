import { Router, type Request } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate.js";
import { createDealSchema, loseDealSchema, moveDealSchema, touchDealSchema, updateDealSchema } from "./deals.schemas.js";
import * as deals from "./deals.service.js";

export function createDealsRouter() {
  const router = Router();
  router.use(authenticate);

  // Every role can see the pipeline; working on it is for the "deals" permission.
  const write = requirePermission("deals");
  const id = (req: Request) => parseId(req.params["id"], "Deal");

  router.get("/", async (req, res) => {
    res.json(await deals.listDeals(req.user!.companyId));
  });

  router.post("/", write, validateBody(createDealSchema), async (req, res) => {
    res.status(201).json({ deal: await deals.createDeal(req.user!, req.body) });
  });

  router.get("/:id", async (req, res) => {
    res.json({ deal: await deals.getDeal(req.user!.companyId, id(req)) });
  });

  router.patch("/:id", write, validateBody(updateDealSchema), async (req, res) => {
    res.json({ deal: await deals.updateDeal(req.user!, id(req), req.body) });
  });

  router.post("/:id/move", write, validateBody(moveDealSchema), async (req, res) => {
    res.json({ deal: await deals.moveDeal(req.user!, id(req), req.body.stage) });
  });

  router.post("/:id/lose", write, validateBody(loseDealSchema), async (req, res) => {
    res.json({ deal: await deals.loseDeal(req.user!, id(req), req.body) });
  });

  router.post("/:id/reopen", write, async (req, res) => {
    res.json({ deal: await deals.reopenDeal(req.user!, id(req)) });
  });

  router.post("/:id/touch", write, validateBody(touchDealSchema), async (req, res) => {
    res.json({ deal: await deals.touchDeal(req.user!, id(req), req.body.awaitingReply) });
  });

  router.delete("/:id", write, async (req, res) => {
    await deals.deleteDeal(req.user!, id(req));
    res.status(204).end();
  });

  return router;
}
