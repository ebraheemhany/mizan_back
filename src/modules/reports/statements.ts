import { Prisma } from "../../generated/prisma/client.js";
import { addDays, businessToday, toDate } from "../../lib/dates.js";
import { Decimal, moneyString, ZERO } from "../../lib/money.js";
import { prisma } from "../../lib/prisma.js";
import { getChart, idsByKey, type ChartAccount } from "../ledger/ledger.chart.js";
import { fiscalYear } from "../ledger/ledger.periods.js";
import { accountTotals, balanceOf } from "../ledger/ledger.service.js";
import { autoLines, type EntrySource } from "../ledger/ledger.sql.js";
import { resolvePeriod } from "./reports.service.js";

/**
 * The balance sheet and the cash flow, read from the books (automatic entries
 * from invoices, payments and expenses, plus posted manual entries).
 */

const accountRef = (a: ChartAccount) => ({ id: a.id, code: a.code, key: a.key, name: a.name, type: a.type });
type Totals = Awaited<ReturnType<typeof accountTotals>>;

/** Revenue minus expenses in a set of totals. */
function profitOf(chart: ChartAccount[], totals: Totals) {
  return chart.reduce((sum, a) => {
    if (a.type === "revenue") return sum.plus(balanceOf(a.type, totals.get(a.id)));
    if (a.type === "expense") return sum.minus(balanceOf(a.type, totals.get(a.id)));
    return sum;
  }, ZERO);
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

/**
 * What the company has and owes at the end of the period (or today, for a period
 * still running). The profit isn't closed into an account: this fiscal year's
 * profit and the years before it show as their own lines under equity, so assets
 * always equal liabilities plus equity.
 */
export async function balanceSheet(companyId: string, periodKey: string | undefined) {
  const today = businessToday();
  const period = resolvePeriod(periodKey, today);
  const asOf = period.end < today ? period.end : today;
  const [chart, company] = await Promise.all([
    getChart(companyId),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { fiscalStartMonth: true } }),
  ]);
  const year = fiscalYear(asOf, company.fiscalStartMonth);
  const [all, beforeYear] = await Promise.all([
    accountTotals(companyId, chart, { to: asOf }),
    accountTotals(companyId, chart, { to: addDays(year.start, -1) }),
  ]);

  const section = (type: "asset" | "liability" | "equity") => {
    const rows = chart.flatMap((a) => {
      if (a.type !== type) return [];
      const amount = balanceOf(a.type, all.get(a.id));
      return amount.isZero() ? [] : [{ account: accountRef(a), amount }];
    });
    return { rows, total: rows.reduce((s, r) => s.plus(r.amount), ZERO) };
  };
  const assets = section("asset");
  const liabilities = section("liability");
  const equity = section("equity");
  const totalProfit = profitOf(chart, all);
  const priorProfit = profitOf(chart, beforeYear);
  const yearProfit = totalProfit.minus(priorProfit);
  const totalEquity = equity.total.plus(totalProfit);

  const rows = (s: ReturnType<typeof section>) =>
    s.rows.map((r) => ({ account: r.account, amount: moneyString(r.amount) }));
  return {
    period: { key: period.key, start: period.start, end: period.end },
    asOf,
    fiscalYear: year,
    assets: { rows: rows(assets), total: moneyString(assets.total) },
    liabilities: { rows: rows(liabilities), total: moneyString(liabilities.total) },
    equity: {
      rows: rows(equity),
      priorYearsProfit: moneyString(priorProfit),
      yearProfit: moneyString(yearProfit),
      total: moneyString(totalEquity),
    },
    totalLiabilitiesAndEquity: moneyString(liabilities.total.plus(totalEquity)),
    balanced: assets.total.equals(liabilities.total.plus(totalEquity)),
  };
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

/** Money the company can spend now: the cash box, the bank and the e-wallets (not cheques waiting to clear). */
const CASH_KEYS = ["cashbox", "bank", "wallet"] as const;
const CASH_SQL = Prisma.raw(`('cashbox', 'bank', 'wallet')`);

type Section = "operating" | "investing" | "financing";
const SECTIONS: Section[] = ["operating", "investing", "financing"];

/** Where a manual entry's cash went, from the account on its other side. */
function classify(a: ChartAccount): { section: Section; key: string } {
  if (a.key === "customers" || a.key === "cheques") return { section: "operating", key: "customers" };
  if (a.key === "suppliers" || a.key === "vat") return { section: "operating", key: a.key };
  if (a.type === "revenue") return { section: "operating", key: "otherIncome" };
  if (a.type === "expense") return { section: "operating", key: a.key ?? "otherExpenses" };
  if (a.type === "asset") return { section: "investing", key: a.key === "fixedAssets" ? "fixedAssets" : "otherAssets" };
  if (a.key === "capital" || a.key === "retained") return { section: "financing", key: "capital" };
  if (a.key === "drawings" || a.key === "loans") return { section: "financing", key: a.key };
  return { section: "financing", key: "otherFinancing" };
}

/**
 * Cash in and out of the cash box, bank and e-wallets during the period, by what
 * it was for: customers' payments and expenses (operating), assets bought or sold
 * (investing), and the owner's money and loans (financing). Moving money between
 * the cash accounts isn't a flow. A manual entry counts under the account on its
 * other side (its biggest one, if there are several).
 */
export async function cashFlow(companyId: string, periodKey: string | undefined) {
  const today = businessToday();
  const period = resolvePeriod(periodKey, today);
  const range = { from: period.start, to: period.to };
  const chart = await getChart(companyId);
  const byKey = idsByKey(chart);
  const cashIds = new Set(CASH_KEYS.map((k) => byKey.get(k)!));
  const accounts = new Map(chart.map((a) => [a.id, a]));

  const [opening, closing, auto, manual] = await Promise.all([
    accountTotals(companyId, chart, { to: addDays(range.from, -1) }),
    accountTotals(companyId, chart, { to: range.to }),
    prisma.$queryRaw<{ source: EntrySource; entryId: string; cash: Decimal }[]>`
      SELECT x."source", x."entryId", SUM(x."debit" - x."credit") AS "cash"
      FROM (${autoLines(companyId)}) x
      WHERE x."key" IN ${CASH_SQL}
        AND x."date" BETWEEN ${toDate(range.from)}::date AND ${toDate(range.to)}::date
      GROUP BY x."source", x."entryId"`,
    prisma.journalEntry.findMany({
      where: { companyId, status: "posted", date: { gte: toDate(range.from), lte: toDate(range.to) } },
      select: { lines: { select: { accountId: true, debit: true, credit: true } } },
    }),
  ]);

  // Expense lines go under their category (a due expense paid later too).
  const expenseIds = auto.filter((r) => r.source === "expense" || r.source === "expensePayment").map((r) => r.entryId);
  const categories = new Map(
    (
      await prisma.expense.findMany({ where: { companyId, id: { in: expenseIds } }, select: { id: true, category: true } })
    ).map((e) => [e.id, e.category as string]),
  );

  const flows = new Map<string, { section: Section; key: string; amount: Decimal }>();
  const add = (section: Section, key: string, amount: Decimal) => {
    if (amount.isZero()) return;
    const id = `${section}:${key}`;
    const f = flows.get(id) ?? { section, key, amount: ZERO };
    flows.set(id, { ...f, amount: f.amount.plus(amount) });
  };

  for (const row of auto) {
    const cash = new Decimal(row.cash);
    if (row.source === "payment" || row.source === "chequeCleared") add("operating", "customers", cash);
    else if (row.source === "expense" || row.source === "expensePayment") {
      add("operating", categories.get(row.entryId) ?? "otherExpenses", cash);
    } else if (row.source === "payrollPayment") add("operating", "salaries", cash);
    else if (row.source === "advance") add("operating", "employeeAdvances", cash);
  }
  for (const entry of manual) {
    let cash = ZERO;
    let other: { account: ChartAccount; size: Decimal } | null = null;
    for (const line of entry.lines) {
      const net = line.debit.minus(line.credit);
      if (cashIds.has(line.accountId)) cash = cash.plus(net);
      else if (!other || net.abs().greaterThan(other.size)) other = { account: accounts.get(line.accountId)!, size: net.abs() };
    }
    // Only cash accounts (a transfer between them), or no cash at all: not a flow.
    if (cash.isZero() || !other) continue;
    const { section, key } = classify(other.account);
    add(section, key, cash);
  }

  const cashIn = (totals: Totals) =>
    CASH_KEYS.reduce((s, k) => s.plus(balanceOf("asset", totals.get(byKey.get(k)!))), ZERO);
  const lines = [...flows.values()].sort(
    (a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || b.amount.abs().comparedTo(a.amount.abs()),
  );
  const total = (s: Section) => lines.filter((l) => l.section === s).reduce((sum, l) => sum.plus(l.amount), ZERO);
  const net = lines.reduce((sum, l) => sum.plus(l.amount), ZERO);

  return {
    period: { key: period.key, start: period.start, end: period.end },
    to: range.to,
    opening: moneyString(cashIn(opening)),
    closing: moneyString(cashIn(closing)),
    net: moneyString(net),
    lines: lines.map((l) => ({ section: l.section, key: l.key, amount: moneyString(l.amount) })),
    totals: Object.fromEntries(SECTIONS.map((s) => [s, moneyString(total(s))])) as Record<Section, string>,
    accounts: CASH_KEYS.map((key) => ({
      key,
      opening: moneyString(balanceOf("asset", opening.get(byKey.get(key)!))),
      closing: moneyString(balanceOf("asset", closing.get(byKey.get(key)!))),
    })),
  };
}
