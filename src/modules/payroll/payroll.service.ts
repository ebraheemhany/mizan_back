// A month's payroll: prepared as a draft from the employees, approved (a cost of the
// month, owed to them) and paid (from each one's account). The books take it from here
// (ledger.sql: payroll, payrollPayment).
import type { PayrollStatus, Prisma, ReceivingAccount } from "../../generated/prisma/client.js";
import { businessToday, monthRange, toDate, toIso } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { sendMail } from "../../lib/mailer.js";
import { Decimal, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { customerMailSender } from "../email/customer-mail.js";
import { payslipEmail } from "../email/templates.js";
import { assertBooksOpen } from "../ledger/ledger.periods.js";
import { advancesByEmployee, unpaidDays } from "./employees.service.js";
import { absenceAmount, employeeRef, monthlyInstallment, payTotals, totalsDto } from "./payroll.math.js";
import type { PayslipEmailInput, UpdateItemInput } from "./payroll.schemas.js";

type Actor = { id: string; companyId: string };
type Db = Prisma.TransactionClient;

const itemSelect = {
  id: true,
  name: true,
  jobTitle: true,
  baseSalary: true,
  allowances: true,
  bonus: true,
  overtime: true,
  absenceDays: true,
  absenceDeduction: true,
  otherDeductions: true,
  deductionNote: true,
  insurance: true,
  employerInsurance: true,
  incomeTax: true,
  advanceDeduction: true,
  payAccount: true,
  note: true,
  workedDays: true,
  monthDays: true,
  employee: {
    select: { id: true, number: true, department: true, email: true, phone: true, bankName: true, bankAccount: true, walletNumber: true },
  },
} satisfies Prisma.PayrollItemSelect;

type ItemRow = Prisma.PayrollItemGetPayload<{ select: typeof itemSelect }>;

const itemDto = (i: ItemRow) => ({
  id: i.id,
  employee: {
    id: i.employee.id,
    ref: employeeRef(i.employee.number),
    department: i.employee.department,
    email: i.employee.email,
    phone: i.employee.phone,
    bankName: i.employee.bankName,
    bankAccount: i.employee.bankAccount,
    walletNumber: i.employee.walletNumber,
  },
  name: i.name,
  jobTitle: i.jobTitle,
  baseSalary: moneyString(i.baseSalary),
  allowances: moneyString(i.allowances),
  bonus: moneyString(i.bonus),
  overtime: moneyString(i.overtime),
  absenceDays: i.absenceDays.toString(),
  absenceDeduction: moneyString(i.absenceDeduction),
  otherDeductions: moneyString(i.otherDeductions),
  deductionNote: i.deductionNote,
  insurance: moneyString(i.insurance),
  employerInsurance: moneyString(i.employerInsurance),
  incomeTax: moneyString(i.incomeTax),
  advanceDeduction: moneyString(i.advanceDeduction),
  payAccount: i.payAccount,
  note: i.note,
  // Joined or left during the month: paid for these days only (null for a whole month).
  partMonth:
    i.workedDays !== null && i.monthDays !== null && i.workedDays < i.monthDays
      ? { days: i.workedDays, of: i.monthDays }
      : null,
  ...totalsDto(payTotals(i)),
});

const monthStart = (month: string) => `${month}-01`;
const monthKeyOf = (date: Date) => toIso(date).slice(0, 7);

/** When the month goes into the books: its last day, or the day it was paid if earlier (never before the month). */
export function accrualDate(month: string, paidOn: string | null) {
  const { start, end } = monthRange(monthStart(month));
  const day = paidOn && paidOn < end ? paidOn : end;
  return day < start ? start : day;
}

async function findRun(db: Db | typeof prisma, companyId: string, month: string) {
  const run = await db.payrollRun.findUnique({
    where: { companyId_month: { companyId, month: toDate(monthStart(month)) } },
    select: { id: true, status: true, month: true, paidOn: true, approvedAt: true, paidAt: true, note: true, createdAt: true },
  });
  if (!run) throw notFound("Payroll");
  return run;
}

function assertStatus(status: PayrollStatus, allowed: PayrollStatus[]) {
  if (!allowed.includes(status)) {
    throw new AppError(409, "PAYROLL_STATUS", `This payroll is ${status}`, { status });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every month prepared so far, newest first, with its totals. */
export async function listRuns(companyId: string) {
  const runs = await prisma.payrollRun.findMany({
    where: { companyId },
    orderBy: { month: "desc" },
    select: {
      id: true,
      month: true,
      status: true,
      paidOn: true,
      items: {
        select: {
          baseSalary: true,
          allowances: true,
          bonus: true,
          overtime: true,
          absenceDeduction: true,
          otherDeductions: true,
          insurance: true,
          employerInsurance: true,
          incomeTax: true,
          advanceDeduction: true,
        },
      },
    },
  });
  return runs.map((r) => ({
    id: r.id,
    month: monthKeyOf(r.month),
    status: r.status,
    paidOn: r.paidOn ? toIso(r.paidOn) : null,
    employees: r.items.length,
    ...totalsDto(sumTotals(r.items)),
  }));
}

function sumTotals(items: Parameters<typeof payTotals>[0][]) {
  return items.reduce(
    (sum, i) => {
      const t = payTotals(i);
      return {
        gross: sum.gross.plus(t.gross),
        deductions: sum.deductions.plus(t.deductions),
        net: sum.net.plus(t.net),
        cost: sum.cost.plus(t.cost),
      };
    },
    { gross: ZERO, deductions: ZERO, net: ZERO, cost: ZERO },
  );
}

export async function getRun(companyId: string, month: string) {
  const run = await findRun(prisma, companyId, month);
  const [items, eligible] = await Promise.all([
    prisma.payrollItem.findMany({ where: { runId: run.id }, select: itemSelect, orderBy: { name: "asc" } }),
    eligibleEmployees(prisma, companyId, month),
  ]);
  const inRun = new Set(items.map((i) => i.employee.id));
  const totals = sumTotals(items);
  const byAccount = (account: ReceivingAccount) =>
    moneyString(items.filter((i) => i.payAccount === account).reduce((s, i) => s.plus(payTotals(i).net), ZERO));
  return {
    id: run.id,
    month,
    status: run.status,
    paidOn: run.paidOn ? toIso(run.paidOn) : null,
    approvedAt: run.approvedAt?.toISOString() ?? null,
    paidAt: run.paidAt?.toISOString() ?? null,
    accrualDate: accrualDate(month, run.paidOn ? toIso(run.paidOn) : null),
    totals: {
      ...totalsDto(totals),
      insurance: moneyString(items.reduce((s, i) => s.plus(i.insurance).plus(i.employerInsurance), ZERO)),
      incomeTax: moneyString(items.reduce((s, i) => s.plus(i.incomeTax), ZERO)),
      advances: moneyString(items.reduce((s, i) => s.plus(i.advanceDeduction), ZERO)),
    },
    byAccount: { bank: byAccount("bank"), cashbox: byAccount("cashbox"), wallet: byAccount("wallet") },
    items: items.map(itemDto),
    // Employees who could be in a draft month but aren't (added since, or taken out).
    missing: eligible.filter((e) => !inRun.has(e.id)).map((e) => ({ id: e.id, name: e.name, ref: employeeRef(e.number) })),
  };
}

// ---------------------------------------------------------------------------
// Preparing a month
// ---------------------------------------------------------------------------

/** Employees on the books during the month: hired by its end, not gone before its start. */
function eligibleEmployees(db: Db | typeof prisma, companyId: string, month: string) {
  const { start, end } = monthRange(monthStart(month));
  return db.employee.findMany({
    where: {
      companyId,
      hireDate: { lte: toDate(end) },
      OR: [{ status: "active" }, { endDate: { gte: toDate(start) } }],
    },
    select: {
      id: true,
      number: true,
      name: true,
      jobTitle: true,
      hireDate: true,
      endDate: true,
      baseSalary: true,
      allowances: true,
      insurance: true,
      employerInsurance: true,
      incomeTax: true,
      payAccount: true,
    },
    orderBy: { name: "asc" },
  });
}

type Eligible = Awaited<ReturnType<typeof eligibleEmployees>>[number];

/**
 * The days on the books in the month for someone who joined or left in it (from the
 * hire date, to the end of service), out of the month's days: they're paid that share.
 */
function workedDays(e: Eligible, month: string) {
  const { start, end } = monthRange(monthStart(month));
  const from = toIso(e.hireDate) > start ? toIso(e.hireDate) : start;
  const to = e.endDate && toIso(e.endDate) < end ? toIso(e.endDate) : end;
  const inMonth = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { workedDays: Math.max(0, Math.min(inMonth, days)), monthDays: inMonth };
}

/** An employee's line for the month, from their pay, attendance and advances. */
async function lineFor(db: Db, companyId: string, e: Eligible, month: string, installment: Decimal) {
  const period = workedDays(e, month);
  const share = period.workedDays / period.monthDays;
  const prorate = (v: Decimal) => (share === 1 ? v : v.times(share).toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  const days = await unpaidDays(db, companyId, e.id, month);
  // A part month takes its share of the insurance and tax too, like the pay.
  const pay = {
    ...period,
    baseSalary: prorate(e.baseSalary),
    allowances: prorate(e.allowances),
    absenceDays: days,
    absenceDeduction: absenceAmount(e.baseSalary, days),
    insurance: prorate(e.insurance),
    employerInsurance: prorate(e.employerInsurance),
    incomeTax: prorate(e.incomeTax),
  };
  // The installment never takes the pay below zero; what's left waits for next month.
  const left = Decimal.max(ZERO, payTotals(pay).net);
  return { name: e.name, jobTitle: e.jobTitle, ...pay, advanceDeduction: Decimal.min(installment, left), payAccount: e.payAccount };
}

/** Each employee's installment this month (what's due on their open advances). */
async function installments(db: Db, companyId: string, employeeIds: string[], exceptRunId?: string) {
  const owed = await advancesByEmployee(db, companyId, employeeIds, exceptRunId);
  return new Map(employeeIds.map((id) => [id, monthlyInstallment(owed.get(id)!.advances)]));
}

/** Prepares a month as a draft, one line per employee on the books then. */
export async function createRun(actor: Actor, month: string) {
  const nextMonth = monthRange(businessToday(), 1).start.slice(0, 7);
  if (month > nextMonth) {
    throw new AppError(400, "VALIDATION_ERROR", "Prepare a month at most one ahead", { field: "month" });
  }
  await prisma.$transaction(async (tx) => {
    const exists = await tx.payrollRun.findUnique({
      where: { companyId_month: { companyId: actor.companyId, month: toDate(monthStart(month)) } },
      select: { id: true },
    });
    if (exists) throw new AppError(409, "PAYROLL_EXISTS", "This month's payroll is already prepared", { month });
    const employees = await eligibleEmployees(tx, actor.companyId, month);
    if (employees.length === 0) throw new AppError(409, "NO_EMPLOYEES", "There are no employees for this month");
    const due = await installments(tx, actor.companyId, employees.map((e) => e.id));
    const run = await tx.payrollRun.create({
      data: { month: toDate(monthStart(month)), companyId: actor.companyId },
      select: { id: true },
    });
    for (const e of employees) {
      await tx.payrollItem.create({
        data: { ...(await lineFor(tx, actor.companyId, e, month, due.get(e.id)!)), runId: run.id, employeeId: e.id, companyId: actor.companyId },
      });
    }
    await audit(tx, actor.companyId, {
      action: "create",
      event: "payrollPrepared",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month, employees: employees.length },
    });
  });
  return getRun(actor.companyId, month);
}

/**
 * Brings a draft up to date with the employees: their pay, attendance and advances,
 * and anyone added since. What was typed on a line (bonus, overtime, deductions,
 * notes, a changed installment or account) is kept.
 */
export async function refreshRun(actor: Actor, month: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["draft"]);
    const [employees, items] = await Promise.all([
      eligibleEmployees(tx, actor.companyId, month),
      tx.payrollItem.findMany({ where: { runId: run.id }, select: { id: true, employeeId: true, advanceDeduction: true } }),
    ]);
    const due = await installments(tx, actor.companyId, employees.map((e) => e.id), run.id);
    const owed = await advancesByEmployee(tx, actor.companyId, employees.map((e) => e.id), run.id);
    for (const e of employees) {
      const line = await lineFor(tx, actor.companyId, e, month, due.get(e.id)!);
      const existing = items.find((i) => i.employeeId === e.id);
      if (!existing) {
        await tx.payrollItem.create({ data: { ...line, runId: run.id, employeeId: e.id, companyId: actor.companyId } });
        continue;
      }
      const { advanceDeduction: _, payAccount: __, ...pay } = line;
      // Never more than they still owe.
      const outstanding = owed.get(e.id)!.outstanding;
      await tx.payrollItem.update({
        where: { id: existing.id },
        data: { ...pay, advanceDeduction: Decimal.min(existing.advanceDeduction, outstanding) },
      });
    }
    await audit(tx, actor.companyId, {
      action: "update",
      event: "payrollRefreshed",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month },
    });
  });
  return getRun(actor.companyId, month);
}

export async function updateItem(actor: Actor, month: string, itemId: string, input: UpdateItemInput) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["draft"]);
    const item = await tx.payrollItem.findFirst({ where: { id: itemId, runId: run.id }, select: { ...itemSelect, employeeId: true } });
    if (!item) throw notFound("Payroll line");
    const data: Prisma.PayrollItemUpdateInput = {};
    for (const key of ["bonus", "overtime", "otherDeductions", "advanceDeduction"] as const) {
      if (input[key] !== undefined) data[key] = money(input[key]!);
    }
    if (input.deductionNote !== undefined) data.deductionNote = input.deductionNote;
    if (input.note !== undefined) data.note = input.note;
    if (input.payAccount !== undefined) data.payAccount = input.payAccount;
    if (input.advanceDeduction !== undefined) {
      const owed = (await advancesByEmployee(tx, actor.companyId, [item.employeeId], run.id)).get(item.employeeId)!;
      if (money(input.advanceDeduction).greaterThan(owed.outstanding)) {
        throw new AppError(400, "ADVANCE_DEDUCTION_TOO_HIGH", "More than this employee still owes", {
          field: "advanceDeduction",
          outstanding: moneyString(owed.outstanding),
        });
      }
    }
    const after = { ...item, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v])) } as ItemRow;
    if (payTotals(after).net.lessThan(0)) {
      throw new AppError(400, "NET_NEGATIVE", "The deductions are more than the pay", { field: "otherDeductions" });
    }
    await tx.payrollItem.update({ where: { id: item.id }, data });
  });
  return getRun(actor.companyId, month);
}

/** Leaves an employee out of a draft month (they can come back with "refresh"). */
export async function removeItem(actor: Actor, month: string, itemId: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["draft"]);
    const { count } = await tx.payrollItem.deleteMany({ where: { id: itemId, runId: run.id } });
    if (count === 0) throw notFound("Payroll line");
  });
  return getRun(actor.companyId, month);
}

export async function deleteRun(actor: Actor, month: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["draft"]);
    await tx.payrollRun.delete({ where: { id: run.id } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "payrollDeleted",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month },
    });
  });
}

// ---------------------------------------------------------------------------
// Approving and paying
// ---------------------------------------------------------------------------

/** Every line's installment within what its employee owes, and no negative pay. */
async function checkLines(tx: Db, companyId: string, runId: string) {
  const items = await tx.payrollItem.findMany({ where: { runId }, select: { ...itemSelect, employeeId: true } });
  if (items.length === 0) throw new AppError(409, "NO_EMPLOYEES", "There are no employees in this payroll");
  const owed = await advancesByEmployee(tx, companyId, items.map((i) => i.employeeId), runId);
  for (const i of items) {
    if (i.advanceDeduction.greaterThan(owed.get(i.employeeId)!.outstanding)) {
      throw new AppError(409, "ADVANCE_DEDUCTION_TOO_HIGH", `${i.name}'s installment is more than they owe`, { name: i.name });
    }
    if (payTotals(i).net.lessThan(0)) {
      throw new AppError(409, "NET_NEGATIVE", `${i.name}'s deductions are more than the pay`, { name: i.name });
    }
  }
  return sumTotals(items);
}

/** Final: the salaries become the month's cost, owed to the employees. */
export async function approveRun(actor: Actor, month: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["draft"]);
    await assertBooksOpen(tx, actor.companyId, [accrualDate(month, null)]);
    const totals = await checkLines(tx, actor.companyId, run.id);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "approved", approvedAt: new Date() } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "payrollApproved",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month, net: moneyString(totals.net), cost: moneyString(totals.cost) },
    });
  });
  return getRun(actor.companyId, month);
}

/** Back to draft to change it (out of the books again). */
export async function reopenRun(actor: Actor, month: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["approved"]);
    await assertBooksOpen(tx, actor.companyId, [accrualDate(month, null)]);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "draft", approvedAt: null } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "payrollReopened",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month },
    });
  });
  return getRun(actor.companyId, month);
}

/** Paid, on `paidOn`: each employee from their line's account. */
export async function payRun(actor: Actor, month: string, paidOn: string) {
  const { start } = monthRange(monthStart(month));
  if (paidOn > businessToday()) {
    throw new AppError(400, "VALIDATION_ERROR", "The payment date can't be in the future", { field: "paidOn" });
  }
  if (paidOn < start) {
    throw new AppError(400, "VALIDATION_ERROR", "The payment date can't be before the month", { field: "paidOn" });
  }
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["approved"]);
    // Paying early moves the cost to the payment day: both days must be open.
    await assertBooksOpen(tx, actor.companyId, [accrualDate(month, null), accrualDate(month, paidOn), paidOn]);
    const totals = await checkLines(tx, actor.companyId, run.id);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "paid", paidOn: toDate(paidOn), paidAt: new Date() } });
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "payrollPaid",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month, net: moneyString(totals.net), paidOn },
    });
  });
  return getRun(actor.companyId, month);
}

/** A payment recorded by mistake: back to approved. */
export async function unpayRun(actor: Actor, month: string) {
  await prisma.$transaction(async (tx) => {
    const run = await findRun(tx, actor.companyId, month);
    assertStatus(run.status, ["paid"]);
    const paidOn = toIso(run.paidOn!);
    await assertBooksOpen(tx, actor.companyId, [paidOn, accrualDate(month, paidOn), accrualDate(month, null)]);
    await tx.payrollRun.update({ where: { id: run.id }, data: { status: "approved", paidOn: null, paidAt: null } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "payrollPaymentCancelled",
      item: { type: "payroll", id: run.id, ref: month },
      values: { month, paidOn },
    });
  });
  return getRun(actor.companyId, month);
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

/** One employee's payslip for a month (approved or paid). */
export async function getPayslip(companyId: string, month: string, itemId: string) {
  const run = await findRun(prisma, companyId, month);
  if (run.status === "draft") throw new AppError(409, "PAYROLL_STATUS", "Payslips come once the payroll is approved", { status: run.status });
  const [item, company] = await Promise.all([
    prisma.payrollItem.findFirst({ where: { id: itemId, runId: run.id }, select: itemSelect }),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, currency: true } }),
  ]);
  if (!item) throw notFound("Payslip");
  return { month, status: run.status, paidOn: run.paidOn ? toIso(run.paidOn) : null, company, item: itemDto(item) };
}

/** Emails the payslip to the employee (replies go to the user who sent it). */
export async function emailPayslip(actor: Actor, month: string, itemId: string, input: PayslipEmailInput) {
  const slip = await getPayslip(actor.companyId, month, itemId);
  if (!slip.item.employee.email) {
    throw new AppError(409, "NO_EMAIL", "This employee has no email address", { field: "email" });
  }
  const sender = await customerMailSender(actor);
  await sendMail(payslipEmail(input.locale, slip.item.employee.email, sender, slip, input.message ?? undefined));
  await prisma.$transaction(async (tx) => {
    await audit(tx, actor.companyId, {
      action: "send",
      event: "payslipEmailed",
      item: { type: "employee", id: slip.item.employee.id, ref: slip.item.name },
      values: { month, to: slip.item.employee.email },
    });
  });
  return { to: slip.item.employee.email };
}

// ---------------------------------------------------------------------------
// For the reports and the dashboard
// ---------------------------------------------------------------------------

/** What approved and paid payroll cost the company, by the month it is in the books (from `from`). */
export async function payrollCostByMonth(companyId: string, from: string) {
  const runs = await prisma.payrollRun.findMany({
    where: { companyId, status: { in: ["approved", "paid"] } },
    select: {
      month: true,
      paidOn: true,
      items: { select: { baseSalary: true, allowances: true, bonus: true, overtime: true, absenceDeduction: true, otherDeductions: true, insurance: true, employerInsurance: true, incomeTax: true, advanceDeduction: true } },
    },
  });
  const byMonth = new Map<string, Decimal>();
  for (const run of runs) {
    const day = accrualDate(monthKeyOf(run.month), run.paidOn ? toIso(run.paidOn) : null);
    if (day < from) continue;
    const key = day.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? ZERO).plus(sumTotals(run.items).cost));
  }
  return byMonth;
}

/** Adds payroll's cost into a month -> amount map of expenses. */
export function withPayroll(expenses: Map<string, Decimal>, payroll: Map<string, Decimal>) {
  const merged = new Map(expenses);
  for (const [month, cost] of payroll) merged.set(month, (merged.get(month) ?? ZERO).plus(cost));
  return merged;
}
