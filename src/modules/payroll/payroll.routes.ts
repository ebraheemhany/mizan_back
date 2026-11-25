import { Router, type RequestHandler } from "express";
import { notFound, parseId } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { authenticate, requirePermission } from "../../middleware/auth.js";
import { parseQuery, validateBody } from "../../middleware/validate.js";
import { checkPayrollAllowed } from "../billing/plans.js";
import { rawUpload, sendFile } from "../files/files.routes.js";
import { fileName } from "../files/files.service.js";
import * as employees from "./employees.service.js";
import * as payroll from "./payroll.service.js";
import {
  advanceSchema,
  attendanceQuerySchema,
  attendanceSchema,
  createEmployeeSchema,
  createRunSchema,
  endEmployeeSchema,
  listEmployeesQuerySchema,
  monthKey,
  payRunSchema,
  payslipEmailSchema,
  updateEmployeeSchema,
  updateItemSchema,
} from "./payroll.schemas.js";

/** Employees and payroll are for the paid plans: the data stays, the pages open again on upgrade. */
const paidPlan: RequestHandler = async (req, _res, next) => {
  await checkPayrollAllowed(prisma, req.user!.companyId);
  next();
};

/** A month from the URL (2026-11); anything else is a 404, like a missing month. */
function parseMonth(value: unknown) {
  const result = monthKey.safeParse(value);
  if (!result.success) throw notFound("Payroll");
  return result.data;
}

export function createEmployeesRouter() {
  const router = Router();
  // Salaries are private: the "payroll" permission (owner + accountant), reading included.
  router.use(authenticate, requirePermission("payroll"), paidPlan);

  router.get("/", async (req, res) => {
    res.json(await employees.listEmployees(req.user!.companyId, parseQuery(listEmployeesQuerySchema, req.query)));
  });

  router.get("/stats", async (req, res) => {
    res.json({ stats: await employees.employeeStats(req.user!.companyId) });
  });

  router.post("/", validateBody(createEmployeeSchema), async (req, res) => {
    res.status(201).json({ employee: await employees.createEmployee(req.user!, req.body) });
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(req.params.id, "Employee");
    const { year } = parseQuery(attendanceQuerySchema, req.query);
    res.json({ employee: await employees.getEmployee(req.user!.companyId, id, year) });
  });

  router.patch("/:id", validateBody(updateEmployeeSchema), async (req, res) => {
    res.json({ employee: await employees.updateEmployee(req.user!, parseId(req.params.id, "Employee"), req.body) });
  });

  router.post("/:id/end", validateBody(endEmployeeSchema), async (req, res) => {
    res.json({ employee: await employees.endEmployee(req.user!, parseId(req.params.id, "Employee"), req.body) });
  });

  router.post("/:id/reactivate", async (req, res) => {
    res.json({ employee: await employees.reactivateEmployee(req.user!, parseId(req.params.id, "Employee")) });
  });

  router.delete("/:id", async (req, res) => {
    await employees.deleteEmployee(req.user!, parseId(req.params.id, "Employee"));
    res.status(204).end();
  });

  // Advances
  router.post("/:id/advances", validateBody(advanceSchema), async (req, res) => {
    const id = parseId(req.params.id, "Employee");
    await employees.addAdvance(req.user!, id, req.body);
    res.status(201).json({ employee: await employees.getEmployee(req.user!.companyId, id) });
  });
  router.delete("/:id/advances/:advanceId", async (req, res) => {
    await employees.deleteAdvance(req.user!, parseId(req.params.id, "Employee"), parseId(req.params.advanceId, "Advance"));
    res.status(204).end();
  });

  // Attendance and leave
  router.post("/:id/attendance", validateBody(attendanceSchema), async (req, res) => {
    res.status(201).json({ entry: await employees.addAttendance(req.user!, parseId(req.params.id, "Employee"), req.body) });
  });
  router.delete("/:id/attendance/:entryId", async (req, res) => {
    await employees.deleteAttendance(req.user!, parseId(req.params.id, "Employee"), parseId(req.params.entryId, "Attendance entry"));
    res.status(204).end();
  });

  // Documents: PUT adds one (the app's upload helper sends files with PUT). The file is
  // the request body (image or PDF, up to 5 MB); its name in X-File-Name, the title
  // (optional) in ?title=.
  router.put("/:id/documents", rawUpload, async (req, res) => {
    const id = parseId(req.params.id, "Employee");
    const title = typeof req.query.title === "string" ? req.query.title.trim().slice(0, 120) || null : null;
    res.status(201).json({ document: await employees.addDocument(req.user!, id, req.body, fileName(req.headers["x-file-name"]), title) });
  });
  router.get("/:id/documents/:documentId", async (req, res) => {
    const file = await employees.getDocument(
      req.user!.companyId,
      parseId(req.params.id, "Employee"),
      parseId(req.params.documentId, "Document"),
    );
    sendFile(res, file);
  });
  router.delete("/:id/documents/:documentId", async (req, res) => {
    await employees.deleteDocument(req.user!, parseId(req.params.id, "Employee"), parseId(req.params.documentId, "Document"));
    res.status(204).end();
  });

  return router;
}

export function createPayrollRouter() {
  const router = Router();
  router.use(authenticate, requirePermission("payroll"), paidPlan);

  router.get("/", async (req, res) => {
    res.json({ items: await payroll.listRuns(req.user!.companyId) });
  });

  router.post("/", validateBody(createRunSchema), async (req, res) => {
    res.status(201).json({ payroll: await payroll.createRun(req.user!, req.body.month) });
  });

  router.get("/:month", async (req, res) => {
    res.json({ payroll: await payroll.getRun(req.user!.companyId, parseMonth(req.params.month)) });
  });

  router.post("/:month/refresh", async (req, res) => {
    res.json({ payroll: await payroll.refreshRun(req.user!, parseMonth(req.params.month)) });
  });

  router.patch("/:month/items/:itemId", validateBody(updateItemSchema), async (req, res) => {
    const item = parseId(req.params.itemId, "Payroll line");
    res.json({ payroll: await payroll.updateItem(req.user!, parseMonth(req.params.month), item, req.body) });
  });

  router.delete("/:month/items/:itemId", async (req, res) => {
    const item = parseId(req.params.itemId, "Payroll line");
    res.json({ payroll: await payroll.removeItem(req.user!, parseMonth(req.params.month), item) });
  });

  router.post("/:month/approve", async (req, res) => {
    res.json({ payroll: await payroll.approveRun(req.user!, parseMonth(req.params.month)) });
  });

  router.post("/:month/reopen", async (req, res) => {
    res.json({ payroll: await payroll.reopenRun(req.user!, parseMonth(req.params.month)) });
  });

  router.post("/:month/pay", validateBody(payRunSchema), async (req, res) => {
    res.json({ payroll: await payroll.payRun(req.user!, parseMonth(req.params.month), req.body.paidOn) });
  });

  router.post("/:month/unpay", async (req, res) => {
    res.json({ payroll: await payroll.unpayRun(req.user!, parseMonth(req.params.month)) });
  });

  router.delete("/:month", async (req, res) => {
    await payroll.deleteRun(req.user!, parseMonth(req.params.month));
    res.status(204).end();
  });

  router.get("/:month/items/:itemId/payslip", async (req, res) => {
    const item = parseId(req.params.itemId, "Payslip");
    res.json({ payslip: await payroll.getPayslip(req.user!.companyId, parseMonth(req.params.month), item) });
  });

  router.post("/:month/items/:itemId/email", validateBody(payslipEmailSchema), async (req, res) => {
    const item = parseId(req.params.itemId, "Payslip");
    res.json(await payroll.emailPayslip(req.user!, parseMonth(req.params.month), item, req.body));
  });

  return router;
}
