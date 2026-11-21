import { Router } from "express";
import { parseId } from "../../lib/params.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { createExpenseSchema, listExpensesQuerySchema, payExpenseSchema } from "./expenses.schemas.js";
import * as expenses from "./expenses.service.js";
import { rawUpload, sendFile } from "../files/files.routes.js";
import { attachReceipt, fileName, getReceipt, removeReceipt } from "../files/files.service.js";

export function createExpensesRouter() {
  const router = Router();
  // Expenses are for the roles with the "expenses" permission (owner + accountant),
  // reading included: what the company spends is financial information.
  router.use(authenticate, requirePermission("expenses"));

  router.get("/", async (req, res) => {
    res.json(await expenses.listExpenses(req.user!.companyId, parseQuery(listExpensesQuerySchema, req.query)));
  });

  router.get("/stats", async (req, res) => {
    res.json({ stats: await expenses.expenseStats(req.user!.companyId) });
  });

  router.get("/due", async (req, res) => {
    res.json({ items: await expenses.dueExpenses(req.user!.companyId) });
  });

  router.get("/export", async (req, res) => {
    const query = parseQuery(listExpensesQuerySchema, req.query);
    res.json({ items: await expenses.exportExpenses(req.user!.companyId, query) });
  });

  router.post("/", validateBody(createExpenseSchema), async (req, res) => {
    res.status(201).json({ expense: await expenses.createExpense(req.user!, req.body) });
  });

  router.post("/:id/pay", validateBody(payExpenseSchema), async (req, res) => {
    const id = parseId(req.params.id, "Expense");
    res.json({ expense: await expenses.payExpense(req.user!, id, req.body.paidFrom) });
  });

  // The receipt: the file is the request body (image or PDF, up to 5 MB).
  router.put("/:id/receipt", rawUpload, async (req, res) => {
    const id = parseId(req.params.id, "Expense");
    res.json(await attachReceipt(req.user!, id, req.body, fileName(req.headers["x-file-name"])));
  });
  router.get("/:id/receipt", async (req, res) => {
    sendFile(res, await getReceipt(req.user!.companyId, parseId(req.params.id, "Expense")));
  });
  router.delete("/:id/receipt", async (req, res) => {
    await removeReceipt(req.user!, parseId(req.params.id, "Expense"));
    res.status(204).end();
  });

  router.delete("/:id", async (req, res) => {
    await expenses.deleteExpense(req.user!, parseId(req.params.id, "Expense"));
    res.status(204).end();
  });

  return router;
}
