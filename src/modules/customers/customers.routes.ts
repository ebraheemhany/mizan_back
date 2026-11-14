import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import {
  bulkAssignSchema,
  bulkDeleteSchema,
  createCustomerSchema,
  importCustomersSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from "./customers.schemas.js";
import * as customers from "./customers.service.js";

export function createCustomersRouter() {
  const router = Router();
  router.use(authenticate);

  const view = requirePermission("viewCustomers");
  const edit = requirePermission("editCustomers");
  const remove = requirePermission("deleteData");

  // --- Read (every role) ---
  router.get("/", view, async (req, res) => {
    res.json(await customers.listCustomers(req.user!.companyId, parseQuery(listCustomersQuerySchema, req.query)));
  });

  // Fixed paths first, so they aren't mistaken for an :id.
  router.get("/export", view, async (req, res) => {
    const query = parseQuery(listCustomersQuerySchema, req.query);
    res.json({ items: await customers.exportCustomers(req.user!.companyId, query) });
  });

  router.get("/:id", view, async (req, res) => {
    res.json({ customer: await customers.getCustomer(req.user!.companyId, parseId(req.params.id, "Customer")) });
  });

  // --- Write ---
  router.post("/", edit, validateBody(createCustomerSchema), async (req, res) => {
    res.status(201).json({ customer: await customers.createCustomer(req.user!.companyId, req.body) });
  });

  router.post("/import", edit, validateBody(importCustomersSchema), async (req, res) => {
    res.status(201).json(await customers.importCustomers(req.user!.companyId, req.body.customers));
  });

  router.post("/bulk-assign", edit, validateBody(bulkAssignSchema), async (req, res) => {
    res.json(await customers.bulkAssignCustomers(req.user!.companyId, req.body.ids, req.body.assignedToId));
  });

  router.post("/bulk-delete", remove, validateBody(bulkDeleteSchema), async (req, res) => {
    res.json(await customers.bulkDeleteCustomers(req.user!.companyId, req.body.ids));
  });

  router.patch("/:id", edit, validateBody(updateCustomerSchema), async (req, res) => {
    const id = parseId(req.params.id, "Customer");
    res.json({ customer: await customers.updateCustomer(req.user!.companyId, id, req.body) });
  });

  router.delete("/:id", remove, async (req, res) => {
    await customers.deleteCustomer(req.user!.companyId, parseId(req.params.id, "Customer"));
    res.status(204).end();
  });

  return router;
}
