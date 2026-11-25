// The arithmetic of pay, shared by employees, payroll months and payslips.
import { Decimal, money, moneyString, ZERO, type DecimalLike } from "../../lib/money.js";

export type PayParts = {
  baseSalary: DecimalLike;
  allowances: DecimalLike;
  bonus?: DecimalLike;
  overtime?: DecimalLike;
  absenceDeduction?: DecimalLike;
  otherDeductions?: DecimalLike;
  insurance: DecimalLike;
  employerInsurance: DecimalLike;
  incomeTax: DecimalLike;
  advanceDeduction?: DecimalLike;
};

/**
 *   gross      = base + allowances + bonus + overtime
 *   deductions = absence + other + insurance + income tax + advance installment
 *   net        = gross - deductions (what the employee is paid)
 *   cost       = gross - absence - other + the company's insurance share (what it costs the company)
 */
export function payTotals(p: PayParts) {
  const d = (v: DecimalLike | undefined) => (v === undefined ? ZERO : money(v));
  const gross = d(p.baseSalary).plus(d(p.allowances)).plus(d(p.bonus)).plus(d(p.overtime));
  const deductions = d(p.absenceDeduction)
    .plus(d(p.otherDeductions))
    .plus(d(p.insurance))
    .plus(d(p.incomeTax))
    .plus(d(p.advanceDeduction));
  const net = gross.minus(deductions);
  const cost = gross.minus(d(p.absenceDeduction)).minus(d(p.otherDeductions)).plus(d(p.employerInsurance));
  return { gross, deductions, net, cost };
}

export const totalsDto = (t: ReturnType<typeof payTotals>) => ({
  gross: moneyString(t.gross),
  deductions: moneyString(t.deductions),
  net: moneyString(t.net),
  cost: moneyString(t.cost),
});

/** A day's pay: the monthly base over 30 days (the usual rule in Egypt). */
export const dailyRate = (baseSalary: DecimalLike) => money(baseSalary).dividedBy(30);

/** What `days` of absence or unpaid leave take off the pay, to the piastre. */
export const absenceAmount = (baseSalary: DecimalLike, days: DecimalLike) =>
  dailyRate(baseSalary).times(new Decimal(days)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export type AdvanceRow = { id: string; amount: Decimal; installment: Decimal; date: Date; createdAt: Date };

/**
 * What is left of each advance, given what has been paid back in total: repayments
 * go to the oldest advance first.
 */
export function allocateRepayments<T extends AdvanceRow>(advances: T[], repaid: DecimalLike) {
  let pool = money(repaid);
  return [...advances]
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
    .map((a) => {
      const paid = Decimal.min(a.amount, pool);
      pool = pool.minus(paid);
      return { ...a, repaid: paid, remaining: a.amount.minus(paid) };
    });
}

/** This month's installment: each open advance's installment, never more than what is left of it. */
export const monthlyInstallment = (allocated: ReturnType<typeof allocateRepayments>) =>
  allocated.reduce((sum, a) => sum.plus(Decimal.min(a.installment, a.remaining)), ZERO);

/** Days from..to, both counted. */
export function calendarDays(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Kinds of attendance that take pay off; kinds that use the yearly paid leave. */
export const UNPAID_KINDS = ["absence", "unpaidLeave"] as const;
export const BALANCE_KINDS = ["annualLeave", "casualLeave"] as const;

export const employeeRef = (number: number) => `EMP-${String(number).padStart(3, "0")}`;
