import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

async function ok<T = any>(res: { status: number; body: any }, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const supplierRequest = (token: string, body: Record<string, unknown>) =>
  api().post("/api/suppliers").set(auth(token)).send(body);
const supplierOf = async (token: string, body: Record<string, unknown>) =>
  (await ok(await supplierRequest(token, body), 201)).supplier as { id: string; name: string };
const supplierDetail = async (token: string, id: string) => (await ok(await api().get(`/api/suppliers/${id}`).set(auth(token)))).supplier;

const expenseRequest = (token: string, body: Record<string, unknown>) =>
  api()
    .post("/api/expenses")
    .set(auth(token))
    .send({ title: "مشتريات", category: "purchases", amount: "1140", date: today(), status: "paid", paidFrom: "cash", ...body });
const expenseOf = async (token: string, body: Record<string, unknown> = {}) =>
  (await ok(await expenseRequest(token, body), 201)).expense as { id: string; vat: string; supplier: { id: string; name: string } | null };

describe("suppliers", () => {
  it("added, listed, edited; one name per company; deleted only without expenses", async () => {
    const { token } = await ownerSession();
    const nile = await supplierOf(token, { name: "شركة النيل للتوريدات", phone: "01012345678", taxNumber: "412-558-903" });
    const dup = await supplierRequest(token, { name: "  شركة النيل للتوريدات " });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("SUPPLIER_EXISTS");
    expect((await supplierRequest(token, { name: "x", taxNumber: "12" })).status).toBe(400);

    const edited = (await ok(await api().patch(`/api/suppliers/${nile.id}`).set(auth(token)).send({ email: "sales@nile.com", notes: "توريد ورق" }))).supplier;
    expect(edited).toMatchObject({ email: "sales@nile.com", notes: "توريد ورق", phone: "01012345678" });

    const other = await supplierOf(token, { name: "مكتب الأمل" });
    await expenseOf(token, { supplierId: nile.id });
    const refused = await api().delete(`/api/suppliers/${nile.id}`).set(auth(token));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SUPPLIER_HAS_EXPENSES");
    expect((await api().delete(`/api/suppliers/${other.id}`).set(auth(token))).status).toBe(204);

    const list = await ok(await api().get("/api/suppliers?q=النيل").set(auth(token)));
    expect(list.items.map((s: { name: string }) => s.name)).toEqual(["شركة النيل للتوريدات"]);

    // Sales can't see suppliers (like expenses); only the owner deletes.
    const sales = await teamMember(token, "sales");
    expect((await api().get("/api/suppliers").set(auth(sales.token))).status).toBe(403);
    const accountant = await teamMember(token, "accountant");
    expect((await api().get("/api/suppliers").set(auth(accountant.token))).status).toBe(200);
    expect((await api().delete(`/api/suppliers/${nile.id}`).set(auth(accountant.token))).status).toBe(403);
  });

  it("an expense's supplier: picked, or found or added by the name typed; another company's is refused", async () => {
    const { token } = await ownerSession();
    const first = await expenseOf(token, { vendor: "مطبعة الشروق" });
    expect(first.supplier?.name).toBe("مطبعة الشروق");
    const second = await expenseOf(token, { vendor: "  مطبعة الشروق" });
    expect(second.supplier?.id).toBe(first.supplier?.id);
    const picked = await expenseOf(token, { supplierId: first.supplier!.id });
    expect(picked.supplier?.id).toBe(first.supplier!.id);
    expect((await ok(await api().get("/api/suppliers").set(auth(token)))).items).toHaveLength(1);

    const other = await ownerSession();
    const theirs = await supplierOf(other.token, { name: "مورد شركة تانية" });
    const res = await expenseRequest(token, { supplierId: theirs.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SUPPLIER");
  });

  it("the statement: what was bought, paid and still owed; paying a due expense clears it", async () => {
    const { token } = await ownerSession();
    const supplier = await supplierOf(token, { name: "شركة النيل" });
    await expenseOf(token, { supplierId: supplier.id, amount: "500" });
    const due = await expenseOf(token, { supplierId: supplier.id, amount: "1200", status: "due", paidFrom: null });
    let detail = await supplierDetail(token, supplier.id);
    expect(detail).toMatchObject({ billed: "1700.00", paid: "500.00", due: "1200.00", expensesCount: 2, lastExpenseDate: today() });
    expect(detail.expenses.map((e: { amount: string }) => e.amount).sort()).toEqual(["1200.00", "500.00"]);
    const list = await ok(await api().get("/api/suppliers").set(auth(token)));
    expect(list.totals).toMatchObject({ count: 1, due: "1200.00", owedTo: 1 });

    await ok(await api().post(`/api/expenses/${due.id}/pay`).set(auth(token)).send({ paidFrom: "bank" }));
    detail = await supplierDetail(token, supplier.id);
    expect(detail).toMatchObject({ billed: "1700.00", paid: "1700.00", due: "0.00" });
  });
});

describe("the migration", () => {
  it("turns each company's vendor names into suppliers (one per name) and links the expenses", async () => {
    const a = await ownerSession();
    const b = await ownerSession();
    // Expenses as they were before suppliers: a name only.
    const old = (companyId: string, vendor: string | null) =>
      prisma.expense.create({
        data: { title: "قديم", category: "rent", amount: "100", date: new Date(), status: "paid", paidFrom: "cash", vendor, companyId },
      });
    await old(a.companyId, "مكتب الأمل");
    await old(a.companyId, " مكتب الامل ".replace("الامل", "الأمل"));
    await old(a.companyId, "شركة النيل");
    await old(a.companyId, null);
    await old(b.companyId, "مكتب الأمل");

    const sql = fs.readFileSync(new URL("../prisma/migrations/20261205000000_suppliers/migration.sql", import.meta.url), "utf8");
    const data = sql.slice(sql.indexOf("-- Existing expenses"));
    for (const statement of data.split(";").map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, "").trim())) {
      await prisma.$executeRawUnsafe(statement);
    }

    const suppliersOf = (companyId: string) =>
      prisma.supplier.findMany({ where: { companyId }, select: { name: true }, orderBy: { name: "asc" } });
    expect((await suppliersOf(a.companyId)).map((s) => s.name)).toEqual(["شركة النيل", "مكتب الأمل"]);
    expect((await suppliersOf(b.companyId)).map((s) => s.name)).toEqual(["مكتب الأمل"]);
    expect(await prisma.expense.count({ where: { vendor: { not: null }, supplierId: null } })).toBe(0);
    expect(await prisma.expense.count({ where: { vendor: null, supplierId: null } })).toBe(1);
  });
});

describe("VAT on purchases (input VAT)", () => {
  it("goes to its own account, comes off the VAT due, and isn't counted as a cost", async () => {
    const { token } = await ownerSession();
    // A sale: 1000 + 140 VAT.
    const customer = (await ok(await api().post("/api/customers").set(auth(token)).send({ name: "عميل" }), 201)).customer;
    await ok(
      await api()
        .post("/api/invoices")
        .set(auth(token))
        .send({ customerId: customer.id, issueDate: today(), terms: 30, send: true, items: [{ description: "خدمة", quantity: "1", unitPrice: "1000" }] }),
      201,
    );
    // A purchase: 1140 paid, 140 of it VAT; and one with none.
    const withVat = await expenseOf(token, { vendor: "مورد", vat: "140" });
    expect(withVat.vat).toBe("140.00");
    await expenseOf(token, { title: "إيجار", category: "rent", amount: "3000" });

    // Books: Dr purchases 1000, Dr VAT input 140 / Cr cash box 1140; no VAT line without VAT.
    const { items } = await ok(await api().get("/api/ledger/entries?pageSize=100&source=expense").set(auth(token)));
    const lines = (e: { lines: { key: string | null; debit: string; credit: string }[] }) =>
      e.lines.map((l) => `${l.key} ${l.debit}/${l.credit}`);
    const entries = items.map(lines);
    expect(entries).toContainEqual(["purchases 1000.00/0.00", "vatInput 140.00/0.00", "cashbox 0.00/1140.00"]);
    expect(entries).toContainEqual(["rent 3000.00/0.00", "cashbox 0.00/3000.00"]);

    // VAT: 140 on sales less 140 on purchases.
    const vat = (await ok(await api().get("/api/reports/vat").set(auth(token)))).vat;
    expect(vat).toMatchObject({ output: "140.00", input: "140.00", due: "0.00", taxablePurchases: "1000.00", purchasesCount: 1 });

    // The cost is 1000 for purchases (the month's expenses: 1000 + 3000).
    const { stats } = await ok(await api().get("/api/expenses/stats").set(auth(token)));
    expect(stats.total).toBe("4000.00");
    expect(stats.byCategory.find((c: { category: string }) => c.category === "purchases").amount).toBe("1000.00");
  });

  it("the VAT must be less than the amount", async () => {
    const { token } = await ownerSession();
    for (const vat of ["1140", "2000", "-1", "abc"]) {
      expect((await expenseRequest(token, { vat })).status, `vat ${vat}`).toBe(400);
    }
    expect((await expenseRequest(token, { vat: "0" })).status).toBe(201);
  });
});
