import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { createSupplierSchema, listSuppliersQuerySchema, updateSupplierSchema } from "./suppliers.schemas.js";
import * as suppliers from "./suppliers.service.js";

/** Suppliers: for whoever handles expenses (owner and accountant); deleting needs deleteData. */
export function createSuppliersRouter() {
  const router = Router();
  router.use(authenticate, requirePermission("expenses"));
  const id = (value: unknown) => parseId(value, "Supplier");

  router.get("/", async (req, res) => {
    res.json(await suppliers.listSuppliers(req.user!.companyId, parseQuery(listSuppliersQuerySchema, req.query)));
  });

  router.get("/:id", async (req, res) => {
    res.json({ supplier: await suppliers.getSupplier(req.user!.companyId, id(req.params.id)) });
  });

  router.post("/", validateBody(createSupplierSchema), async (req, res) => {
    res.status(201).json({ supplier: await suppliers.createSupplier(req.user!, req.body) });
  });

  router.patch("/:id", validateBody(updateSupplierSchema), async (req, res) => {
    res.json({ supplier: await suppliers.updateSupplier(req.user!, id(req.params.id), req.body) });
  });

  router.delete("/:id", requirePermission("deleteData"), async (req, res) => {
    await suppliers.deleteSupplier(req.user!, id(req.params.id));
    res.status(204).end();
  });

  return router;
}
