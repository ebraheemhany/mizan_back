import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testMail } from "../src/lib/mailer.js";
import { addDays, businessToday, monthRange } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
const thisMonth = () => today().slice(0, 7);
const lastMonth = () => monthRange(today(), -1).start.slice(0, 7);

type Res = { status: number; body: any };
function ok(res: Res, status = 200) {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const hire = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post("/api/employees")
    .set(auth(token))
    .send({
      name: "أحمد سمير",
      jobTitle: "محاسب",
      department: "المالية",
      hireDate: "2025-01-01",
      baseSalary: "9000",
      allowances: "1000",
      insurance: "700",
      employerInsurance: "1100",
      incomeTax: "300",
      payAccount: "bank",
      email: "ahmed@example.com",
      ...body,
    });

const employeeOf = async (token: string, body: Record<string, unknown> = {}) => ok(await hire(token, body), 201).employee;
const runOf = async (token: string, month = thisMonth()) =>
  ok(await api().post("/api/payroll").set(auth(token)).send({ month }), 201).payroll;
const action = (token: string, month: string, what: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/payroll/${month}/${what}`).set(auth(token)).send(body);
const trialBalance = async (token: string) => {
  const tb = ok(await api().get("/api/ledger/trial-balance?month=all").set(auth(token)));
  const rows = tb.rows as { account: { key: string }; debit: string; credit: string }[];
  return { balanced: tb.balanced as boolean, of: (key: string) => rows.find((r) => r.account.key === key) };
};

describe("employees: access", () => {
  it("is for paid plans", async () => {
    const owner = await ownerSession({ plan: "free" });
    const res = await api().get("/api/employees").set(auth(owner.token));
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "PLAN_FEATURE", details: { feature: "payroll" } });
    expect((await api().get("/api/payroll").set(auth(owner.token))).status).toBe(402);
  });

  it("is for the owner and accountants: salaries are private", async () => {
    const owner = await ownerSession();
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    expect((await api().get("/api/employees").set(auth(accountant.token))).status).toBe(200);
    expect((await api().get("/api/employees").set(auth(sales.token))).status).toBe(403);
    expect((await api().get("/api/payroll").set(auth(sales.token))).status).toBe(403);
  });
});

describe("employees", () => {
  it("adds them numbered, with their monthly figures", async () => {
    const { token } = await ownerSession();
    const first = await employeeOf(token);
    const second = await employeeOf(token, { name: "منى خالد", baseSalary: "6000", allowances: "", insurance: "", employerInsurance: "", incomeTax: "" });
    expect(first).toMatchObject({ ref: "EMP-001", status: "active", payAccount: "bank" });
    // gross 10000; net = 10000 - 700 - 300; cost = 10000 + 1100.
    expect(first.pay).toMatchObject({ baseSalary: "9000.00", gross: "10000.00", net: "9000.00", cost: "11100.00" });
    expect(second).toMatchObject({ ref: "EMP-002" });
    expect(second.pay).toMatchObject({ gross: "6000.00", net: "6000.00", cost: "6000.00" });

    const list = ok(await api().get("/api/employees").set(auth(token)));
    expect(list.counts).toEqual({ active: 2, ended: 0, all: 2 });
    expect(list.departments).toEqual(["المالية"]);
    const stats = ok(await api().get("/api/employees/stats").set(auth(token))).stats;
    expect(stats).toMatchObject({ active: 2, monthlyNet: "15000.00", monthlyCost: "17100.00" });
  });

  it("refuses insurance and tax above the pay, also when edited alone", async () => {
    const { token } = await ownerSession();
    expect((await hire(token, { baseSalary: "1000", allowances: "0", insurance: "900", incomeTax: "200" })).status).toBe(400);
    const e = await employeeOf(token);
    const res = await api().patch(`/api/employees/${e.id}`).set(auth(token)).send({ incomeTax: "9500" });
    expect(res.status).toBe(400);
  });

  it("an edit changes only what is sent", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    const updated = ok(await api().patch(`/api/employees/${e.id}`).set(auth(token)).send({ jobTitle: "مدير مالي" })).employee;
    expect(updated).toMatchObject({ jobTitle: "مدير مالي", name: "أحمد سمير", email: "ahmed@example.com" });
    expect(updated.pay.allowances).toBe("1000.00");
  });

  it("end of service and back; only someone with no history can be deleted", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    const ended = ok(await api().post(`/api/employees/${e.id}/end`).set(auth(token)).send({ endDate: today(), reason: "استقالة" })).employee;
    expect(ended).toMatchObject({ status: "ended", endDate: today(), endReason: "استقالة" });
    const back = ok(await api().post(`/api/employees/${e.id}/reactivate`).set(auth(token))).employee;
    expect(back).toMatchObject({ status: "active", endDate: null });

    await api().post(`/api/employees/${e.id}/advances`).set(auth(token)).send({ amount: "1000", installment: "500", date: today(), paidFrom: "cashbox" }).expect(201);
    const refused = await api().delete(`/api/employees/${e.id}`).set(auth(token));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("EMPLOYEE_HAS_HISTORY");

    const other = await employeeOf(token, { name: "موظف بالغلط" });
    expect((await api().delete(`/api/employees/${other.id}`).set(auth(token))).status).toBe(204);
  });
});

describe("documents", () => {
  it("keeps a contract or ID on the employee's file", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    const pdf = Buffer.from("%PDF-1.4 contract");
    const base = `/api/employees/${e.id}`;
    const added = ok(
      await api()
        .put(`${base}/documents?title=${encodeURIComponent("عقد العمل")}`)
        .set(auth(token))
        .set("Content-Type", "application/pdf")
        .set("X-File-Name", encodeURIComponent("contract.pdf"))
        .send(pdf),
      201,
    ).document;
    expect(added).toMatchObject({ title: "عقد العمل", name: "contract.pdf", contentType: "application/pdf" });
    const file = await api().get(`${base}/documents/${added.id}`).set(auth(token));
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    const html = await api().put(`${base}/documents`).set(auth(token)).set("Content-Type", "text/html").send("<script>");
    expect(html.status).toBe(415);
    expect((await api().delete(`${base}/documents/${added.id}`).set(auth(token))).status).toBe(204);
    expect(ok(await api().get(base).set(auth(token))).employee.documents).toEqual([]);
  });
});

describe("advances", () => {
  it("are paid out in the books and taken back from the pay, oldest first", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    await api().post(`/api/employees/${e.id}/advances`).set(auth(token)).send({ amount: "3000", installment: "1000", date: addDays(today(), -1), paidFrom: "cashbox" }).expect(201);
    const detail = ok(await api().post(`/api/employees/${e.id}/advances`).set(auth(token)).send({ amount: "500", installment: "500", date: today(), paidFrom: "bank" }), 201).employee;
    expect(detail.advances.outstanding).toBe("3500.00");

    let tb = await trialBalance(token);
    expect(tb.balanced).toBe(true);
    expect(tb.of("employeeAdvances")).toMatchObject({ debit: "3500.00" });

    // This month takes both installments (1000 + 500).
    const run = await runOf(token);
    expect(run.items[0]).toMatchObject({ advanceDeduction: "1500.00" });
    ok(await action(token, thisMonth(), "approve"));
    const after = ok(await api().get(`/api/employees/${e.id}`).set(auth(token))).employee;
    expect(after.advances.outstanding).toBe("2000.00");
    // Newest first in the list; the 1500 taken back all went to the older 3000.
    expect(after.advances.items.map((a: { remaining: string }) => a.remaining)).toEqual(["500.00", "1500.00"]);

    // Something already paid back can't be deleted.
    const repaid = after.advances.items[1];
    const refused = await api().delete(`/api/employees/${e.id}/advances/${repaid.id}`).set(auth(token));
    expect(refused.body.error.code).toBe("ADVANCE_REPAID");

    tb = await trialBalance(token);
    expect(tb.balanced).toBe(true);
    expect(tb.of("employeeAdvances")).toMatchObject({ debit: "2000.00" });
  });
});

describe("attendance and leave", () => {
  it("absence and unpaid leave come off the draft month's pay; the month is final once approved", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    const day = `${thisMonth()}-02`;
    await runOf(token);
    await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "absence", from: day, to: day }).expect(201);
    await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "unpaidLeave", from: `${thisMonth()}-05`, to: `${thisMonth()}-05`, days: "0.5" }).expect(201);
    // Sick leave is paid.
    await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "sickLeave", from: `${thisMonth()}-08`, to: `${thisMonth()}-09` }).expect(201);

    const run = ok(await api().get(`/api/payroll/${thisMonth()}`).set(auth(token))).payroll;
    // 1.5 days of 9000 / 30 = 450.
    expect(run.items[0]).toMatchObject({ absenceDays: "1.5", absenceDeduction: "450.00" });

    ok(await action(token, thisMonth(), "approve"));
    const locked = await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "absence", from: day, to: day });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("PAYROLL_MONTH_FINAL");
  });

  it("annual and casual leave come out of the year's balance", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token, { leaveDays: 3 });
    const from = `${thisMonth()}-01`;
    await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "annualLeave", from, to: addDays(from, 1) }).expect(201);
    const over = await api().post(`/api/employees/${e.id}/attendance`).set(auth(token)).send({ kind: "casualLeave", from: addDays(from, 3), to: addDays(from, 4) });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatchObject({ code: "LEAVE_BALANCE", details: { remaining: "1" } });
    const summary = ok(await api().get(`/api/employees/${e.id}`).set(auth(token))).employee.attendance.summary;
    expect(summary).toMatchObject({ allowed: 3, used: "2", remaining: "1" });
  });

  it("one entry stays inside one month", async () => {
    const { token } = await ownerSession();
    const e = await employeeOf(token);
    const res = await api()
      .post(`/api/employees/${e.id}/attendance`)
      .set(auth(token))
      .send({ kind: "annualLeave", from: monthRange(today()).end, to: addDays(monthRange(today()).end, 1) });
    expect(res.status).toBe(400);
  });
});

describe("payroll", () => {
  it("a month: prepared, edited, approved and paid, with its entries in the books", async () => {
    const { token } = await ownerSession();
    await employeeOf(token);
    await employeeOf(token, { name: "منى خالد", baseSalary: "6000", allowances: "0", insurance: "0", employerInsurance: "0", incomeTax: "0", payAccount: "cashbox" });
    // Gone before this month: not in it.
    const gone = await employeeOf(token, { name: "سابق" });
    await api().post(`/api/employees/${gone.id}/end`).set(auth(token)).send({ endDate: monthRange(today(), -1).end }).expect(200);

    const run = await runOf(token);
    expect(run).toMatchObject({ month: thisMonth(), status: "draft" });
    expect(run.items.map((i: { name: string }) => i.name)).toEqual(["أحمد سمير", "منى خالد"]);
    expect(run.totals).toMatchObject({ gross: "16000.00", net: "15000.00", cost: "17100.00" });
    // A draft is not in the books.
    expect((await trialBalance(token)).of("salaries")).toBeUndefined();

    const ahmed = run.items.find((i: { name: string }) => i.name === "أحمد سمير");
    const edited = ok(
      await api().patch(`/api/payroll/${thisMonth()}/items/${ahmed.id}`).set(auth(token)).send({ bonus: "500", otherDeductions: "200", deductionNote: "تأخير" }),
    ).payroll;
    expect(edited.items.find((i: { id: string }) => i.id === ahmed.id)).toMatchObject({ bonus: "500.00", net: "9300.00", cost: "11400.00" });
    const negative = await api().patch(`/api/payroll/${thisMonth()}/items/${ahmed.id}`).set(auth(token)).send({ otherDeductions: "99999" });
    expect(negative.body.error.code).toBe("NET_NEGATIVE");
    expect((await runOf(token).catch((e: Error) => e.message)) as string).toContain("PAYROLL_EXISTS");

    const approved = ok(await action(token, thisMonth(), "approve")).payroll;
    expect(approved.status).toBe("approved");
    // Approved: can't be edited.
    expect((await api().patch(`/api/payroll/${thisMonth()}/items/${ahmed.id}`).set(auth(token)).send({ bonus: "1" })).body.error.code).toBe("PAYROLL_STATUS");

    let tb = await trialBalance(token);
    expect(tb.balanced).toBe(true);
    // Cost 11400 + 6000; net owed 9300 + 6000; insurance 700 + 1100; tax 300.
    expect(tb.of("salaries")).toMatchObject({ debit: "17400.00" });
    expect(tb.of("salariesPayable")).toMatchObject({ credit: "15300.00" });
    expect(tb.of("socialInsurance")).toMatchObject({ credit: "1800.00" });
    expect(tb.of("payrollTax")).toMatchObject({ credit: "300.00" });

    const paid = ok(await action(token, thisMonth(), "pay", { paidOn: today() })).payroll;
    expect(paid).toMatchObject({ status: "paid", paidOn: today(), byAccount: { bank: "9300.00", cashbox: "6000.00", wallet: "0.00" } });
    tb = await trialBalance(token);
    expect(tb.balanced).toBe(true);
    expect(tb.of("salariesPayable")).toBeUndefined();
    expect(tb.of("bank")).toMatchObject({ credit: "9300.00" });
    expect(tb.of("cashbox")).toMatchObject({ credit: "6000.00" });

    // The journal shows them with their month.
    const journal = ok(await api().get("/api/ledger/entries?source=payroll").set(auth(token)));
    expect(journal.items.map((e: { source: string; month: string }) => `${e.source} ${e.month}`).sort()).toEqual([
      `payroll ${thisMonth()}`,
      `payrollPayment ${thisMonth()}`,
    ]);

    // A payment recorded by mistake goes back; an approved month back to draft; a draft can go.
    ok(await action(token, thisMonth(), "unpay"));
    ok(await action(token, thisMonth(), "reopen"));
    expect((await api().delete(`/api/payroll/${thisMonth()}`).set(auth(token))).status).toBe(204);
    expect((await trialBalance(token)).of("salaries")).toBeUndefined();
  });

  it("someone who joined during the month is paid for the days on the books", async () => {
    const { token } = await ownerSession();
    const { start, end } = monthRange(`${lastMonth()}-01`);
    const days = Number(end.slice(8));
    // Joined on the 11th: (days - 10) / days of the month.
    await employeeOf(token, { hireDate: addDays(start, 10), baseSalary: "3000", allowances: "0", insurance: "0", employerInsurance: "0", incomeTax: "0" });
    const run = await runOf(token, lastMonth());
    expect(run.items[0].baseSalary).toBe(((3000 * (days - 10)) / days).toFixed(2));
    // The line says so: these days out of the month's.
    expect(run.items[0].partMonth).toEqual({ days: days - 10, of: days });
  });

  it("a whole month says nothing about days; a hire date moved back and refreshed pays the whole month", async () => {
    const { token } = await ownerSession();
    const { start, end } = monthRange(`${lastMonth()}-01`);
    const days = Number(end.slice(8));
    // Added late in the month (e.g. with today's date as the hire date)...
    const late = await employeeOf(token, { hireDate: addDays(start, days - 4), baseSalary: "4000", allowances: "3000", insurance: "100", employerInsurance: "50", incomeTax: "100" });
    const before = (await runOf(token, lastMonth())).items[0];
    expect(before.partMonth).toEqual({ days: 4, of: days });
    expect(before.gross).toBe(((7000 * 4) / days).toFixed(2));

    // ...then the real hire date: refreshing the draft pays the whole month.
    await api().patch(`/api/employees/${late.id}`).set(auth(token)).send({ hireDate: "2025-01-01" }).expect(200);
    const item = ok(await action(token, lastMonth(), "refresh")).payroll.items[0];
    expect(item.partMonth).toBeNull();
    expect(item.gross).toBe("7000.00");
    expect(item.net).toBe("6800.00");
  });

  it("a part month takes its share of insurance and tax, and the installment never makes the pay negative", async () => {
    const { token } = await ownerSession();
    const { start, end } = monthRange(`${lastMonth()}-01`);
    const days = Number(end.slice(8));
    // On the books for the last 2 days of the month only.
    const late = await employeeOf(token, {
      hireDate: addDays(start, days - 2),
      baseSalary: "3000",
      allowances: "0",
      insurance: "600",
      employerInsurance: "900",
      incomeTax: "300",
    });
    await api().post(`/api/employees/${late.id}/advances`).set(auth(token)).send({ amount: "1000", installment: "1000", date: addDays(start, days - 2), paidFrom: "cashbox" }).expect(201);
    const [item] = (await runOf(token, lastMonth())).items;
    const share = (v: number) => ((v * 2) / days).toFixed(2);
    expect(item.baseSalary).toBe(share(3000));
    expect(item.insurance).toBe(share(600));
    expect(item.employerInsurance).toBe(share(900));
    expect(item.incomeTax).toBe(share(300));
    // Only what the pay leaves is taken this month; the net is zero, not negative.
    expect(item.net).toBe("0.00");
    expect(Number(item.advanceDeduction)).toBeLessThan(1000);
    ok(await action(token, lastMonth(), "approve"));
  });

  it("refresh brings in new employees and keeps what was typed", async () => {
    const { token } = await ownerSession();
    await employeeOf(token);
    const run = await runOf(token);
    await api().patch(`/api/payroll/${thisMonth()}/items/${run.items[0].id}`).set(auth(token)).send({ bonus: "750" }).expect(200);
    const late = await employeeOf(token, { name: "زين" });
    const before = ok(await api().get(`/api/payroll/${thisMonth()}`).set(auth(token))).payroll;
    expect(before.missing.map((m: { id: string }) => m.id)).toEqual([late.id]);
    const after = ok(await action(token, thisMonth(), "refresh")).payroll;
    expect(after.items).toHaveLength(2);
    expect(after.missing).toEqual([]);
    expect(after.items.find((i: { name: string }) => i.name === "أحمد سمير").bonus).toBe("750.00");
  });

  it("can't be approved in a closed month", async () => {
    const { token } = await ownerSession();
    await employeeOf(token);
    await runOf(token, lastMonth());
    await api().post("/api/ledger/periods/close").set(auth(token)).send({ month: lastMonth() }).expect(200);
    const res = await action(token, lastMonth(), "approve");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PERIOD_CLOSED");
  });

  it("counts in the profit and loss as salaries", async () => {
    const { token } = await ownerSession();
    await employeeOf(token);
    await runOf(token);
    ok(await action(token, thisMonth(), "approve"));
    const summary = ok(await api().get("/api/reports/summary").set(auth(token)));
    const salaries = (summary.lines ?? summary.summary?.lines).find((l: { key: string }) => l.key === "salaries");
    expect(salaries.amount).toBe("11100.00");
  });
});

describe("payslips", () => {
  it("come once approved, and can be emailed to the employee", async () => {
    const owner = await ownerSession();
    const { token } = owner;
    await employeeOf(token);
    const run = await runOf(token);
    const itemId = run.items[0].id;
    expect((await api().get(`/api/payroll/${thisMonth()}/items/${itemId}/payslip`).set(auth(token))).status).toBe(409);
    ok(await action(token, thisMonth(), "approve"));
    const slip = ok(await api().get(`/api/payroll/${thisMonth()}/items/${itemId}/payslip`).set(auth(token))).payslip;
    expect(slip).toMatchObject({ month: thisMonth(), status: "approved", item: { net: "9000.00", name: "أحمد سمير" } });

    // Only a confirmed sender: replies come back to them.
    const unverified = await api().post(`/api/payroll/${thisMonth()}/items/${itemId}/email`).set(auth(token)).send({});
    expect(unverified.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerifiedAt: new Date() } });
    const sent = ok(await api().post(`/api/payroll/${thisMonth()}/items/${itemId}/email`).set(auth(token)).send({}));
    expect(sent).toEqual({ to: "ahmed@example.com" });
    const mail = testMail.outbox.find((m) => m.tag === "payslip")!;
    expect(mail.to).toBe("ahmed@example.com");
    expect(mail.text).toContain("صافي المرتب");
    expect(mail.text).toContain("9,000");
  });
});
