import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import {
  createProductSchema,
  importProductsSchema,
  listProductsQuerySchema,
  nextCodeQuerySchema,
  updateProductSchema,
} from "./products.schemas.js";
import * as products from "./products.service.js";
import { adjustStock, adjustStockSchema, listMovements, movementsQuerySchema } from "./stock.js";

export function createProductsRouter() {
  const router = Router();
  router.use(authenticate);

  // Everyone can see the catalog (they need it to write invoices and quotes).
  const edit = requirePermission("editProducts");
  const remove = requirePermission("deleteData");

  router.get("/", async (req, res) => {
    res.json(await products.listProducts(req.user!.companyId, parseQuery(listProductsQuerySchema, req.query)));
  });

  // Fixed paths first, so they aren't mistaken for an :id.
  router.get("/next-code", async (req, res) => {
    const { type } = parseQuery(nextCodeQuerySchema, req.query);
    res.json({ code: await products.nextCode(req.user!.companyId, type) });
  });

  router.get("/:id", async (req, res) => {
    res.json({ product: await products.getProduct(req.user!.companyId, parseId(req.params.id, "Product")) });
  });

  router.post("/", edit, validateBody(createProductSchema), async (req, res) => {
    res.status(201).json({ product: await products.createProduct(req.user!.companyId, req.body, req.user!.id) });
  });

  router.post("/import", edit, validateBody(importProductsSchema), async (req, res) => {
    res.status(201).json(await products.importProducts(req.user!.companyId, req.body.products, req.user!.id));
  });

  router.patch("/:id", edit, validateBody(updateProductSchema), async (req, res) => {
    const id = parseId(req.params.id, "Product");
    res.json({ product: await products.updateProduct(req.user!.companyId, id, req.body, req.user!.id) });
  });

  // Its stock log (everyone who sees the catalog), and goods received / a count / damage.
  router.get("/:id/movements", async (req, res) => {
    const id = parseId(req.params.id, "Product");
    res.json(await listMovements(req.user!.companyId, id, parseQuery(movementsQuerySchema, req.query)));
  });

  router.post("/:id/stock", edit, validateBody(adjustStockSchema), async (req, res) => {
    const id = parseId(req.params.id, "Product");
    await adjustStock(req.user!, id, req.body);
    res.json({ product: await products.getProduct(req.user!.companyId, id) });
  });

  router.delete("/:id", remove, async (req, res) => {
    await products.deleteProduct(req.user!.companyId, parseId(req.params.id, "Product"));
    res.status(204).end();
  });

  return router;
}
