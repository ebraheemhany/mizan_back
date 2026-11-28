import type { AccountType } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";

/**
 * The built-in accounts every company gets. Invoices, payments and expenses post
 * to these (by key); the expense categories use their own keys. Names come from
 * the app's translations (Accounts.names.<key>).
 */
export const SYSTEM_ACCOUNTS = [
  { key: "cashbox", code: "1010", type: "asset" },
  { key: "bank", code: "1020", type: "asset" },
  { key: "wallet", code: "1030", type: "asset" },
  // A customer's cheque until it clears.
  { key: "cheques", code: "1040", type: "asset" },
  { key: "customers", code: "1100", type: "asset" },
  // Salary advances, owed back by the employees (taken off their pay).
  { key: "employeeAdvances", code: "1160", type: "asset" },
  // VAT paid on purchases (input VAT): taken off the VAT owed on sales when filing.
  // Goods on hand, at their cost (stock movements with a cost, ledger.sql "stock").
  { key: "inventory", code: "1150", type: "asset" },
  { key: "vatInput", code: "1170", type: "asset" },
  { key: "fixedAssets", code: "1500", type: "asset" },
  // Expenses saved as due, until they are paid.
  { key: "suppliers", code: "2100", type: "liability" },
  { key: "vat", code: "2200", type: "liability" },
  { key: "loans", code: "2300", type: "liability" },
  // Payroll: net pay owed to employees until paid; insurance (both shares) and income
  // tax withheld, owed to the government until paid (with a manual entry).
  { key: "salariesPayable", code: "2410", type: "liability" },
  { key: "socialInsurance", code: "2420", type: "liability" },
  { key: "payrollTax", code: "2430", type: "liability" },
  { key: "capital", code: "3000", type: "equity" },
  { key: "retained", code: "3100", type: "equity" },
  { key: "drawings", code: "3200", type: "equity" },
  { key: "sales", code: "4000", type: "revenue" },
  { key: "otherIncome", code: "4900", type: "revenue" },
  // Purchases are the cost of sales (same as the profit and loss report).
  { key: "purchases", code: "5000", type: "expense" },
  // What the goods sold cost, and stock lost (damage, counts; a gain lowers it).
  { key: "cogs", code: "5010", type: "expense" },
  { key: "stockLoss", code: "5020", type: "expense" },
  { key: "salaries", code: "5100", type: "expense" },
  { key: "rent", code: "5200", type: "expense" },
  { key: "marketing", code: "5300", type: "expense" },
  { key: "utilities", code: "5400", type: "expense" },
  { key: "software", code: "5500", type: "expense" },
  { key: "otherExpenses", code: "5900", type: "expense" },
] as const satisfies readonly { key: string; code: string; type: AccountType }[];

export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[number]["key"];

/** Debit-side accounts grow with debits; the others with credits. */
export const debitNormal = (type: AccountType) => type === "asset" || type === "expense";

export type ChartAccount = {
  id: string;
  code: string;
  key: string | null;
  name: string | null;
  type: AccountType;
};

/**
 * The company's chart, adding the built-in accounts the first time (and any
 * added to the app since). skipDuplicates makes two first visits at once harmless.
 */
export async function getChart(companyId: string): Promise<ChartAccount[]> {
  const select = { id: true, code: true, key: true, name: true, type: true } as const;
  let accounts = await prisma.ledgerAccount.findMany({ where: { companyId }, select, orderBy: { code: "asc" } });
  const have = new Set(accounts.map((a) => a.key));
  if (SYSTEM_ACCOUNTS.some((a) => !have.has(a.key))) {
    await prisma.ledgerAccount.createMany({
      data: SYSTEM_ACCOUNTS.map((a) => ({ ...a, companyId })),
      skipDuplicates: true,
    });
    accounts = await prisma.ledgerAccount.findMany({ where: { companyId }, select, orderBy: { code: "asc" } });
  }
  return accounts;
}

/** Built-in key -> account id. */
export const idsByKey = (chart: ChartAccount[]) =>
  new Map(chart.flatMap((a) => (a.key ? [[a.key, a.id] as const] : [])));
