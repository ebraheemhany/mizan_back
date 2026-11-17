import { Prisma } from "../generated/prisma/client.js";

/**
 * Money is never calculated with JavaScript numbers (0.1 + 0.2 !== 0.3).
 * Everything goes through Decimal and is rounded to 2 decimals, half away from
 * zero (the usual rule on invoices: 0.005 -> 0.01).
 */
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
/** Anything that can become a Decimal: "1850.50", 14, or a Decimal. */
export type DecimalLike = Prisma.Decimal | string | number;

export const money = (value: DecimalLike) =>
  new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const ZERO = new Decimal(0);

/** 2-decimal string for the API ("1850.00"). */
export const moneyString = (value: DecimalLike) => money(value).toFixed(2);

export type LineInput = { quantity: string; unitPrice: string };

/**
 * Invoice totals. Each line is rounded on its own, so the printed line amounts
 * always add up to the printed subtotal; VAT is worked out once on the subtotal.
 */
export function invoiceTotals(lines: LineInput[], vatRate: DecimalLike) {
  const amounts = lines.map((line) => money(new Decimal(line.quantity).times(line.unitPrice)));
  const subtotal = amounts.reduce((sum, a) => sum.plus(a), ZERO);
  const vat = money(subtotal.times(vatRate).dividedBy(100));
  return { amounts, subtotal, vat, total: subtotal.plus(vat) };
}
