// Employees: their file, pay, advances, attendance and documents.
import type { AttendanceKind, Prisma } from "../../generated/prisma/client.js";
import { businessToday, toDate, toIso, yearRange } from "../../lib/dates.js";
import { AppError } from "../../lib/errors.js";
import { Decimal, money, moneyString, ZERO } from "../../lib/money.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit, changedFields } from "../audit/audit.service.js";
import { checkUpload } from "../files/files.service.js";
import { assertBooksOpen } from "../ledger/ledger.periods.js";
import {
  absenceAmount,
  allocateRepayments,
  BALANCE_KINDS,
  calendarDays,
  employeeRef,
  payTotals,
  totalsDto,
  UNPAID_KINDS,
} from "./payroll.math.js";
import {
  deductionsWithinPay,
  type AdvanceInput,
  type AttendanceInput,
  type CreateEmployeeInput,
  type EndEmployeeInput,
  type ListEmployeesQuery,
  type UpdateEmployeeInput,
} from "./payroll.schemas.js";

type Actor = { id: string; companyId: string };
type Db = Prisma.TransactionClient;

const employeeSelect = {
  id: true,
  number: true,
  name: true,
  jobTitle: true,
  department: true,
  phone: true,
  email: true,
  nationalId: true,
  address: true,
  hireDate: true,
  status: true,
  endDate: true,
  endReason: true,
  baseSalary: true,
  allowances: true,
  insurance: true,
  employerInsurance: true,
  incomeTax: true,
  payAccount: true,
  bankName: true,
  bankAccount: true,
  walletNumber: true,
  leaveDays: true,
  notes: true,
  createdAt: true,
} satisfies Prisma.EmployeeSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof employeeSelect }>;

function toDto(e: EmployeeRow) {
  return {
    id: e.id,
    number: e.number,
    ref: employeeRef(e.number),
    name: e.name,
    jobTitle: e.jobTitle,
    department: e.department,
    phone: e.phone,
    email: e.email,
    nationalId: e.nationalId,
    address: e.address,
    hireDate: toIso(e.hireDate),
    status: e.status,
    endDate: e.endDate ? toIso(e.endDate) : null,
    endReason: e.endReason,
    pay: {
      baseSalary: moneyString(e.baseSalary),
      allowances: moneyString(e.allowances),
      insurance: moneyString(e.insurance),
      employerInsurance: moneyString(e.employerInsurance),
      incomeTax: moneyString(e.incomeTax),
      // A normal month: no bonus, absence or installment.
      ...totalsDto(payTotals(e)),
    },
    payAccount: e.payAccount,
    bankName: e.bankName,
    bankAccount: e.bankAccount,
    walletNumber: e.walletNumber,
    leaveDays: e.leaveDays,
    notes: e.notes,
    createdAt: e.createdAt.toISOString(),
  };
}

export async function findEmployee(db: Db | typeof prisma, companyId: string, id: string) {
  const row = await db.employee.findFirst({ where: { id, companyId }, select: employeeSelect });
  if (!row) throw notFound("Employee");
  return row;
}

// ---------------------------------------------------------------------------
// Advances: what each employee still owes
// ---------------------------------------------------------------------------

/**
 * Paid back so far by each employee: the installments taken off their pay in
 * approved or paid months (optionally leaving one month out, to check it).
 */
export async function repaidByEmployee(db: Db | typeof prisma, companyId: string, employeeIds: string[], exceptRunId?: string) {
  if (employeeIds.length === 0) return new Map<string, Decimal>();
  const rows = await db.payrollItem.groupBy({
    by: ["employeeId"],
    where: {
      companyId,
      employeeId: { in: employeeIds },
      run: { status: { in: ["approved", "paid"] }, ...(exceptRunId ? { id: { not: exceptRunId } } : {}) },
    },
    _sum: { advanceDeduction: true },
  });
  return new Map(rows.map((r) => [r.employeeId, r._sum.advanceDeduction ?? ZERO]));
}

/** Each employee's advances with what is left of them (oldest paid back first), and the total owed. */
export async function advancesByEmployee(db: Db | typeof prisma, companyId: string, employeeIds: string[], exceptRunId?: string) {
  const [advances, repaid] = await Promise.all([
    db.employeeAdvance.findMany({
      where: { companyId, employeeId: { in: employeeIds } },
      select: { id: true, employeeId: true, amount: true, installment: true, date: true, paidFrom: true, note: true, createdAt: true },
    }),
    repaidByEmployee(db, companyId, employeeIds, exceptRunId),
  ]);
  const result = new Map<string, { advances: ReturnType<typeof allocateRepayments<(typeof advances)[number]>>; outstanding: Decimal }>();
  for (const id of employeeIds) {
    const own = advances.filter((a) => a.employeeId === id);
    const allocated = allocateRepayments(own, repaid.get(id) ?? ZERO);
    result.set(id, { advances: allocated, outstanding: allocated.reduce((s, a) => s.plus(a.remaining), ZERO) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// List, stats, one employee
// ---------------------------------------------------------------------------

/** `q` for a case-insensitive contains. */
const like = (q: string) => ({ contains: q, mode: "insensitive" as const });

export async function listEmployees(companyId: string, query: ListEmployeesQuery) {
  const q = query.q?.trim();
  const asNumber = q && /^(emp-?)?\d+$/i.test(q) ? Number(q.replace(/\D/g, "")) : null;
  const where: Prisma.EmployeeWhereInput = {
    companyId,
    ...(query.status !== "all" ? { status: query.status } : {}),
    ...(query.department ? { department: query.department } : {}),
    ...(q
      ? {
          OR: [
            { name: like(q) },
            { jobTitle: like(q) },
            { department: like(q) },
            { phone: { contains: q } },
            ...(asNumber !== null ? [{ number: asNumber }] : []),
          ],
        }
      : {}),
  };
  const [rows, counts, departments] = await Promise.all([
    prisma.employee.findMany({ where, select: employeeSelect, orderBy: [{ status: "asc" }, { name: "asc" }] }),
    prisma.employee.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
    prisma.employee.findMany({
      where: { companyId, department: { not: null } },
      select: { department: true },
      distinct: ["department"],
      orderBy: { department: "asc" },
    }),
  ]);
  const owed = await advancesByEmployee(prisma, companyId, rows.map((r) => r.id));
  const count = (status: "active" | "ended") => counts.find((c) => c.status === status)?._count._all ?? 0;
  return {
    items: rows.map((r) => ({ ...toDto(r), advancesOutstanding: moneyString(owed.get(r.id)?.outstanding ?? ZERO) })),
    counts: { active: count("active"), ended: count("ended"), all: count("active") + count("ended") },
    departments: departments.map((d) => d.department!).filter(Boolean),
  };
}

/** The cards above the list. */
export async function employeeStats(companyId: string) {
  const today = toDate(businessToday());
  const [active, advanced, repaid, today_, lastRun] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId, status: "active" },
      select: { baseSalary: true, allowances: true, insurance: true, employerInsurance: true, incomeTax: true },
    }),
    prisma.employeeAdvance.aggregate({ where: { companyId }, _sum: { amount: true } }),
    prisma.payrollItem.aggregate({
      where: { companyId, run: { status: { in: ["approved", "paid"] } } },
      _sum: { advanceDeduction: true },
    }),
    prisma.attendanceEntry.groupBy({
      by: ["kind"],
      where: { companyId, from: { lte: today }, to: { gte: today }, employee: { status: "active" } },
      _count: { _all: true },
    }),
    prisma.payrollRun.findFirst({ where: { companyId }, orderBy: { month: "desc" }, select: { month: true, status: true } }),
  ]);
  const monthly = active.reduce(
    (sum, e) => {
      const t = payTotals(e);
      return { net: sum.net.plus(t.net), cost: sum.cost.plus(t.cost) };
    },
    { net: ZERO, cost: ZERO },
  );
  const away = (kinds: AttendanceKind[]) =>
    today_.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r._count._all, 0);
  return {
    active: active.length,
    monthlyNet: moneyString(monthly.net),
    monthlyCost: moneyString(monthly.cost),
    advancesOutstanding: moneyString((advanced._sum.amount ?? ZERO).minus(repaid._sum.advanceDeduction ?? ZERO)),
    onLeaveToday: away(["annualLeave", "casualLeave", "sickLeave", "unpaidLeave"]),
    absentToday: away(["absence"]),
    lastPayroll: lastRun ? { month: toIso(lastRun.month).slice(0, 7), status: lastRun.status } : null,
  };
}

const attendanceSelect = { id: true, kind: true, from: true, to: true, days: true, note: true, createdAt: true } as const;

type AttendanceRow = { id: string; kind: AttendanceKind; from: Date; to: Date; days: Decimal; note: string | null; createdAt: Date };
const attendanceDto = (a: AttendanceRow) => ({
  id: a.id,
  kind: a.kind,
  from: toIso(a.from),
  to: toIso(a.to),
  days: a.days.toString(),
  note: a.note,
  createdAt: a.createdAt.toISOString(),
});

/** The paid-leave balance of a calendar year, and the other kinds counted. */
function leaveSummary(leaveDays: number, entries: AttendanceRow[]) {
  const total = (kinds: readonly AttendanceKind[]) =>
    entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s.plus(e.days), ZERO);
  const used = total(BALANCE_KINDS);
  return {
    allowed: leaveDays,
    used: used.toString(),
    remaining: new Decimal(leaveDays).minus(used).toString(),
    sick: total(["sickLeave"]).toString(),
    unpaid: total(["unpaidLeave"]).toString(),
    absence: total(["absence"]).toString(),
  };
}

export async function getEmployee(companyId: string, id: string, year?: number) {
  const row = await findEmployee(prisma, companyId, id);
  const range = yearRange(year ? `${year}-01-01` : businessToday());
  const [owed, attendance, documents, payslips] = await Promise.all([
    advancesByEmployee(prisma, companyId, [id]),
    prisma.attendanceEntry.findMany({
      where: { companyId, employeeId: id, from: { gte: toDate(range.start), lte: toDate(range.end) } },
      select: attendanceSelect,
      orderBy: [{ from: "desc" }, { createdAt: "desc" }],
    }),
    prisma.employeeDocument.findMany({
      where: { companyId, employeeId: id },
      select: { id: true, title: true, createdAt: true, file: { select: { name: true, contentType: true, size: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payrollItem.findMany({
      where: { companyId, employeeId: id },
      select: {
        id: true,
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
        run: { select: { month: true, status: true, paidOn: true } },
      },
      orderBy: { run: { month: "desc" } },
    }),
  ]);
  const own = owed.get(id)!;
  return {
    ...toDto(row),
    advances: {
      outstanding: moneyString(own.outstanding),
      items: own.advances
        .sort((a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime())
        .map((a) => ({
          id: a.id,
          amount: moneyString(a.amount),
          installment: moneyString(a.installment),
          date: toIso(a.date),
          paidFrom: a.paidFrom,
          note: a.note,
          repaid: moneyString(a.repaid),
          remaining: moneyString(a.remaining),
        })),
    },
    attendance: {
      year: Number(range.start.slice(0, 4)),
      summary: leaveSummary(row.leaveDays, attendance),
      items: attendance.map(attendanceDto),
    },
    documents: documents.map((d) => ({
      id: d.id,
      title: d.title,
      name: d.file.name,
      contentType: d.file.contentType,
      size: d.file.size,
      createdAt: d.createdAt.toISOString(),
    })),
    payslips: payslips.map((p) => ({
      itemId: p.id,
      month: toIso(p.run.month).slice(0, 7),
      status: p.run.status,
      paidOn: p.run.paidOn ? toIso(p.run.paidOn) : null,
      ...totalsDto(payTotals(p)),
    })),
  };
}

// ---------------------------------------------------------------------------
// Add, edit, end of service, delete
// ---------------------------------------------------------------------------

const edits = (input: UpdateEmployeeInput) => {
  const data: Prisma.EmployeeUncheckedUpdateInput = {};
  const set = <K extends keyof UpdateEmployeeInput>(key: K, map: (v: NonNullable<UpdateEmployeeInput[K]>) => unknown) => {
    const value = input[key];
    if (value === undefined) return;
    (data as Record<string, unknown>)[key] = value === null ? null : map(value as NonNullable<UpdateEmployeeInput[K]>);
  };
  for (const key of ["name", "jobTitle", "department", "phone", "email", "nationalId", "address", "bankName", "bankAccount", "walletNumber", "notes", "payAccount", "leaveDays"] as const) {
    set(key, (v) => v);
  }
  for (const key of ["baseSalary", "allowances", "insurance", "employerInsurance", "incomeTax"] as const) {
    set(key, (v) => money(v));
  }
  set("hireDate", (v) => toDate(v));
  return data;
};

export async function createEmployee(actor: Actor, input: CreateEmployeeInput) {
  const row = await prisma.$transaction(async (tx) => {
    const { employeeNextNumber } = await tx.company.update({
      where: { id: actor.companyId },
      data: { employeeNextNumber: { increment: 1 } },
      select: { employeeNextNumber: true },
    });
    const created = await tx.employee.create({
      data: {
        ...(edits(input) as Prisma.EmployeeUncheckedCreateInput),
        number: employeeNextNumber - 1,
        companyId: actor.companyId,
      },
      select: employeeSelect,
    });
    await audit(tx, actor.companyId, {
      action: "create",
      event: "employeeAdded",
      item: { type: "employee", id: created.id, ref: created.name },
      values: { name: created.name, jobTitle: created.jobTitle ?? undefined, salary: moneyString(created.baseSalary) },
    });
    return created;
  });
  return toDto(row);
}

export async function updateEmployee(actor: Actor, id: string, input: UpdateEmployeeInput) {
  const row = await prisma.$transaction(async (tx) => {
    const before = await findEmployee(tx, actor.companyId, id);
    const pay = {
      baseSalary: input.baseSalary ?? moneyString(before.baseSalary),
      allowances: input.allowances ?? moneyString(before.allowances),
      insurance: input.insurance ?? moneyString(before.insurance),
      incomeTax: input.incomeTax ?? moneyString(before.incomeTax),
    };
    if (!deductionsWithinPay(pay)) {
      throw new AppError(400, "VALIDATION_ERROR", "Insurance and tax are more than the salary", { field: "insurance" });
    }
    if (input.hireDate && before.endDate && input.hireDate > toIso(before.endDate)) {
      throw new AppError(400, "VALIDATION_ERROR", "The hire date is after the end of service", { field: "hireDate" });
    }
    const updated = await tx.employee.update({ where: { id: before.id }, data: edits(input), select: employeeSelect });
    const changed = changedFields(
      { ...toDto(before), ...toDto(before).pay } as Record<string, unknown>,
      { ...toDto(updated), ...toDto(updated).pay } as Record<string, unknown>,
    ).filter((k) => k in input);
    if (changed.length) {
      await audit(tx, actor.companyId, {
        action: "update",
        event: "employeeUpdated",
        item: { type: "employee", id: updated.id, ref: updated.name },
        values: { fields: changed },
      });
    }
    return updated;
  });
  return toDto(row);
}

/** End of service: kept with their history, out of the coming months' payroll. */
export async function endEmployee(actor: Actor, id: string, input: EndEmployeeInput) {
  const row = await prisma.$transaction(async (tx) => {
    const before = await findEmployee(tx, actor.companyId, id);
    if (input.endDate < toIso(before.hireDate)) {
      throw new AppError(400, "VALIDATION_ERROR", "The end of service is before the hire date", { field: "endDate" });
    }
    const updated = await tx.employee.update({
      where: { id: before.id },
      data: { status: "ended", endDate: toDate(input.endDate), endReason: input.reason ?? null },
      select: employeeSelect,
    });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "employeeEnded",
      item: { type: "employee", id: updated.id, ref: updated.name },
      values: { date: input.endDate, reason: input.reason ?? undefined },
    });
    return updated;
  });
  return toDto(row);
}

export async function reactivateEmployee(actor: Actor, id: string) {
  const row = await prisma.$transaction(async (tx) => {
    const before = await findEmployee(tx, actor.companyId, id);
    const updated = await tx.employee.update({
      where: { id: before.id },
      data: { status: "active", endDate: null, endReason: null },
      select: employeeSelect,
    });
    if (before.status !== "active") {
      await audit(tx, actor.companyId, {
        action: "update",
        event: "employeeReactivated",
        item: { type: "employee", id: updated.id, ref: updated.name },
      });
    }
    return updated;
  });
  return toDto(row);
}

/**
 * Only an employee with no pay history and no advances (one added by mistake):
 * anyone who was paid ends their service instead, so the books keep them.
 */
export async function deleteEmployee(actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, id);
    const [items, advances] = await Promise.all([
      tx.payrollItem.count({ where: { employeeId: id } }),
      tx.employeeAdvance.count({ where: { employeeId: id } }),
    ]);
    if (items > 0 || advances > 0) {
      throw new AppError(409, "EMPLOYEE_HAS_HISTORY", "This employee has payroll or advances; end their service instead");
    }
    // Their documents' files go too (the documents cascade from the employee).
    const files = await tx.employeeDocument.findMany({ where: { employeeId: id }, select: { fileId: true } });
    await tx.employee.delete({ where: { id } });
    if (files.length) await tx.storedFile.deleteMany({ where: { id: { in: files.map((f) => f.fileId) }, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "employeeDeleted",
      item: { type: "employee", id, ref: employee.name },
    });
  });
}

// ---------------------------------------------------------------------------
// Advances
// ---------------------------------------------------------------------------

export async function addAdvance(actor: Actor, employeeId: string, input: AdvanceInput) {
  return prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, employeeId);
    if (employee.status !== "active") {
      throw new AppError(409, "EMPLOYEE_ENDED", "This employee's service has ended");
    }
    // Paid out on its date: that day must be open in the books.
    await assertBooksOpen(tx, actor.companyId, [input.date]);
    const created = await tx.employeeAdvance.create({
      data: {
        amount: money(input.amount),
        installment: money(input.installment),
        date: toDate(input.date),
        paidFrom: input.paidFrom,
        note: input.note ?? null,
        employeeId,
        companyId: actor.companyId,
      },
      select: { id: true },
    });
    await audit(tx, actor.companyId, {
      action: "payment",
      event: "advancePaid",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { amount: input.amount, installment: input.installment, paidFrom: input.paidFrom },
    });
    return created;
  });
}

/** A mistaken advance, as long as nothing of it has been paid back yet. */
export async function deleteAdvance(actor: Actor, employeeId: string, advanceId: string) {
  await prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, employeeId);
    const owed = (await advancesByEmployee(tx, actor.companyId, [employeeId])).get(employeeId)!;
    const advance = owed.advances.find((a) => a.id === advanceId);
    if (!advance) throw notFound("Advance");
    if (advance.repaid.greaterThan(0)) {
      throw new AppError(409, "ADVANCE_REPAID", "Part of this advance has been paid back already");
    }
    await assertBooksOpen(tx, actor.companyId, [toIso(advance.date)]);
    await tx.employeeAdvance.delete({ where: { id: advanceId } });
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "advanceDeleted",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { amount: moneyString(advance.amount) },
    });
  });
}

// ---------------------------------------------------------------------------
// Attendance and leave
// ---------------------------------------------------------------------------

/** The employee's line of a month's payroll, and that month's state. */
async function payrollLine(tx: Db, companyId: string, employeeId: string, month: string) {
  return tx.payrollItem.findFirst({
    where: { companyId, employeeId, run: { month: toDate(`${month}-01`) } },
    select: { id: true, run: { select: { status: true } } },
  });
}

/** Recounts the absence on the employee's line of a draft month (after attendance changed). */
export async function syncAbsence(tx: Db, companyId: string, employeeId: string, month: string) {
  const line = await payrollLine(tx, companyId, employeeId, month);
  if (!line || line.run.status !== "draft") return;
  const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { baseSalary: true } });
  const days = await unpaidDays(tx, companyId, employeeId, month);
  await tx.payrollItem.update({
    where: { id: line.id },
    data: { absenceDays: days, absenceDeduction: absenceAmount(employee.baseSalary, days) },
  });
}

/** Days of absence and unpaid leave in a month. */
export async function unpaidDays(db: Db | typeof prisma, companyId: string, employeeId: string, month: string) {
  const start = toDate(`${month}-01`);
  const end = toDate(toIso(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))));
  const sum = await db.attendanceEntry.aggregate({
    where: { companyId, employeeId, kind: { in: [...UNPAID_KINDS] }, from: { gte: start, lte: end } },
    _sum: { days: true },
  });
  return sum._sum.days ?? ZERO;
}

/** A month whose payroll is approved or paid is final for its attendance too. */
async function assertMonthEditable(tx: Db, companyId: string, employeeId: string, month: string) {
  const line = await payrollLine(tx, companyId, employeeId, month);
  if (line && line.run.status !== "draft") {
    throw new AppError(409, "PAYROLL_MONTH_FINAL", "This month's payroll is approved; return it to draft first", { month });
  }
}

export async function addAttendance(actor: Actor, employeeId: string, input: AttendanceInput) {
  return prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, employeeId);
    const month = input.from.slice(0, 7);
    await assertMonthEditable(tx, actor.companyId, employeeId, month);
    const days = new Decimal(input.days ?? calendarDays(input.from, input.to));
    if (days.greaterThan(calendarDays(input.from, input.to))) {
      throw new AppError(400, "VALIDATION_ERROR", "More days than the dates cover", { field: "days" });
    }
    if ((BALANCE_KINDS as readonly string[]).includes(input.kind)) {
      // Annual and casual leave come out of the year's paid days.
      const year = yearRange(input.from);
      const used = await tx.attendanceEntry.aggregate({
        where: {
          companyId: actor.companyId,
          employeeId,
          kind: { in: [...BALANCE_KINDS] },
          from: { gte: toDate(year.start), lte: toDate(year.end) },
        },
        _sum: { days: true },
      });
      const left = new Decimal(employee.leaveDays).minus(used._sum.days ?? ZERO);
      if (days.greaterThan(left)) {
        throw new AppError(409, "LEAVE_BALANCE", "Not enough paid leave left this year", { remaining: left.toString() });
      }
    }
    const created = await tx.attendanceEntry.create({
      data: {
        kind: input.kind,
        from: toDate(input.from),
        to: toDate(input.to),
        days,
        note: input.note ?? null,
        employeeId,
        companyId: actor.companyId,
      },
      select: attendanceSelect,
    });
    await syncAbsence(tx, actor.companyId, employeeId, month);
    await audit(tx, actor.companyId, {
      action: "create",
      event: "attendanceAdded",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { kind: input.kind, from: input.from, to: input.to, days: days.toString() },
    });
    return attendanceDto(created);
  });
}

export async function deleteAttendance(actor: Actor, employeeId: string, entryId: string) {
  await prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, employeeId);
    const entry = await tx.attendanceEntry.findFirst({ where: { id: entryId, employeeId, companyId: actor.companyId }, select: attendanceSelect });
    if (!entry) throw notFound("Attendance entry");
    const month = toIso(entry.from).slice(0, 7);
    await assertMonthEditable(tx, actor.companyId, employeeId, month);
    await tx.attendanceEntry.delete({ where: { id: entryId } });
    await syncAbsence(tx, actor.companyId, employeeId, month);
    await audit(tx, actor.companyId, {
      action: "delete",
      event: "attendanceDeleted",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { kind: entry.kind, from: toIso(entry.from), days: entry.days.toString() },
    });
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function addDocument(actor: Actor, employeeId: string, body: unknown, name: string | null, title: string | null) {
  const { data, contentType } = checkUpload("document", body);
  const employee = await findEmployee(prisma, actor.companyId, employeeId);
  return prisma.$transaction(async (tx) => {
    const file = await tx.storedFile.create({
      data: { kind: "document", contentType, size: data.length, name, data: new Uint8Array(data), companyId: actor.companyId, createdById: actor.id },
      select: { id: true },
    });
    const doc = await tx.employeeDocument.create({
      data: { title: (title ?? name ?? "").slice(0, 120) || "—", fileId: file.id, employeeId, companyId: actor.companyId },
      select: { id: true, title: true, createdAt: true },
    });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "employeeDocumentAdded",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { title: doc.title, size: data.length },
    });
    return { id: doc.id, title: doc.title, name, contentType, size: data.length, createdAt: doc.createdAt.toISOString() };
  });
}

export async function getDocument(companyId: string, employeeId: string, documentId: string) {
  const doc = await prisma.employeeDocument.findFirst({
    where: { id: documentId, employeeId, companyId },
    select: { file: { select: { contentType: true, data: true, name: true } } },
  });
  if (!doc) throw notFound("Document");
  return doc.file;
}

export async function deleteDocument(actor: Actor, employeeId: string, documentId: string) {
  await prisma.$transaction(async (tx) => {
    const employee = await findEmployee(tx, actor.companyId, employeeId);
    const doc = await tx.employeeDocument.findFirst({
      where: { id: documentId, employeeId, companyId: actor.companyId },
      select: { id: true, title: true, fileId: true },
    });
    if (!doc) throw notFound("Document");
    // The document goes with its file.
    await tx.storedFile.deleteMany({ where: { id: doc.fileId, companyId: actor.companyId } });
    await audit(tx, actor.companyId, {
      action: "update",
      event: "employeeDocumentRemoved",
      item: { type: "employee", id: employee.id, ref: employee.name },
      values: { title: doc.title },
    });
  });
}
