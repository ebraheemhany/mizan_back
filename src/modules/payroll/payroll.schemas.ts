import { z } from "zod";
import { isoDate } from "../invoices/invoices.schemas.js";

export const payAccounts = ["bank", "cashbox", "wallet"] as const;
export const attendanceKinds = ["absence", "annualLeave", "casualLeave", "sickLeave", "unpaidLeave"] as const;

/** Money: up to 2 decimals; empty or null means 0 (a missing value stays missing). */
const amountOrZero = z.preprocess(
  (v) => {
    if (v === null) return "0";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v.trim().replace(/,/g, "") || "0";
    return v;
  },
  z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Must be a number with up to 2 decimals"),
);

const positiveAmount = amountOrZero.refine((v) => Number(v) > 0, "Must be more than 0");

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string().max(max).nullable().optional(),
  );

const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v),
  z.email().max(254).nullable().optional(),
);

/** A month as YYYY-MM. */
export const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Must be a month like 2026-11");

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

/** The fields as sent when updating: a missing one isn't changed (so no defaults here). */
const employeeEdits = {
  name: z.string().trim().min(2).max(120),
  jobTitle: optionalText(80),
  department: optionalText(80),
  phone: optionalText(30),
  email: optionalEmail,
  nationalId: optionalText(30),
  address: optionalText(200),
  hireDate: isoDate,
  baseSalary: positiveAmount,
  allowances: amountOrZero,
  insurance: amountOrZero,
  employerInsurance: amountOrZero,
  incomeTax: amountOrZero,
  payAccount: z.enum(payAccounts),
  bankName: optionalText(80),
  bankAccount: optionalText(60),
  walletNumber: optionalText(30),
  leaveDays: z.coerce.number().int().min(0).max(60),
  notes: optionalText(1000),
};

/** What comes off the pay can't be more than the pay itself. */
export function deductionsWithinPay(v: { baseSalary: string; allowances: string; insurance: string; incomeTax: string }) {
  return Number(v.insurance) + Number(v.incomeTax) <= Number(v.baseSalary) + Number(v.allowances);
}

export const createEmployeeSchema = z
  .object({
    ...employeeEdits,
    allowances: employeeEdits.allowances.default("0"),
    insurance: employeeEdits.insurance.default("0"),
    employerInsurance: employeeEdits.employerInsurance.default("0"),
    incomeTax: employeeEdits.incomeTax.default("0"),
    payAccount: employeeEdits.payAccount.default("bank"),
    leaveDays: employeeEdits.leaveDays.default(21),
  })
  .refine(deductionsWithinPay, { path: ["insurance"], message: "Insurance and tax are more than the salary" });

// Checked against the employee's saved pay in the service (only some fields may come).
export const updateEmployeeSchema = z.object(employeeEdits).partial();

export const endEmployeeSchema = z.object({
  endDate: isoDate,
  reason: optionalText(200),
});

export const listEmployeesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "ended", "all"]).default("active"),
  department: z.string().trim().max(80).optional(),
});

// ---------------------------------------------------------------------------
// Advances, attendance, documents
// ---------------------------------------------------------------------------

export const advanceSchema = z
  .object({
    amount: positiveAmount,
    // Taken off each month's pay until it is paid back.
    installment: positiveAmount,
    date: isoDate,
    paidFrom: z.enum(payAccounts),
    note: optionalText(200),
  })
  .refine((v) => Number(v.installment) <= Number(v.amount), {
    path: ["installment"],
    message: "The installment can't be more than the advance",
  });

const days = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : v),
  z
    .string()
    .regex(/^\d{1,2}(\.5)?$/, "Whole or half days")
    .refine((v) => Number(v) > 0, "Must be more than 0"),
);

export const attendanceSchema = z
  .object({
    kind: z.enum(attendanceKinds),
    from: isoDate,
    to: isoDate,
    // Defaults to the days from..to.
    days: days.optional(),
    note: optionalText(200),
  })
  .superRefine((v, ctx) => {
    if (v.to < v.from) ctx.addIssue({ code: "custom", path: ["to"], message: "The end is before the start" });
    else if (v.to.slice(0, 7) !== v.from.slice(0, 7)) {
      // A month's payroll counts the month's entries: one entry per month.
      ctx.addIssue({ code: "custom", path: ["to"], message: "Split it at the end of the month" });
    }
  });

export const attendanceQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

export const createRunSchema = z.object({ month: monthKey });

/**
 * What can be changed on an employee's line of a draft month. Absence comes from
 * the attendance entries (add or remove those to change it).
 */
export const updateItemSchema = z.object({
  bonus: amountOrZero.optional(),
  overtime: amountOrZero.optional(),
  otherDeductions: amountOrZero.optional(),
  deductionNote: optionalText(200),
  advanceDeduction: amountOrZero.optional(),
  payAccount: z.enum(payAccounts).optional(),
  note: optionalText(200),
});

export const payRunSchema = z.object({ paidOn: isoDate });

export const payslipEmailSchema = z.object({
  locale: z.enum(["ar", "en"]).default("ar"),
  message: optionalText(1000),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type EndEmployeeInput = z.infer<typeof endEmployeeSchema>;
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;
export type AdvanceInput = z.infer<typeof advanceSchema>;
export type AttendanceInput = z.infer<typeof attendanceSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type PayslipEmailInput = z.infer<typeof payslipEmailSchema>;
