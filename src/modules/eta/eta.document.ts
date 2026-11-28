// Building an ETA document (invoice "I" or credit note "C", v1.0 JSON) from our data
// (https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/, /credit-note-v1-0/).
//
// The math follows ETA's validation equations for a VAT-only line
// (https://sdk.invoicing.eta.gov.eg/document-validation-rules/):
//   salesTotal = quantity × amountEGP; netTotal = salesTotal − discount (none here);
//   T1 = netTotal × rate; total = netTotal + T1
// and the document totals are the sums of the lines as sent. Everything is decimal, kept
// to at most 5 decimals (ETA's limit), so no tolerance is relied on. ETA's total can differ
// from ours (VAT rounded to piasters on the whole invoice) by a fraction of a piaster.
import { Prisma } from "../../generated/prisma/client.js";

type Decimal = Prisma.Decimal;
type DecimalValue = Decimal | string | number;
const D = (v: DecimalValue) => new Prisma.Decimal(v);
const ZERO = D(0);
/** A value as ETA takes it: a JSON number with at most 5 decimals. */
const num = (v: Decimal) => Number(v.toDecimalPlaces(5, Prisma.Decimal.ROUND_HALF_UP).toString());
const round5 = (v: Decimal) => v.toDecimalPlaces(5, Prisma.Decimal.ROUND_HALF_UP);

/** Signed documents are version 1.0; 0.9 is the same structure with signature checks off (preprod testing). */
export type EtaVersion = "1.0" | "0.9";

export type EtaAddress = {
  branchID?: string;
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string;
  floor?: string;
  room?: string;
  landmark?: string;
  additionalInformation?: string;
};

export type EtaParty = { type: "B" | "P" | "F"; id?: string; name: string; address?: EtaAddress };

export type EtaLineInput = {
  description: string;
  itemType: "GS1" | "EGS";
  itemCode: string;
  unitType: string;
  quantity: DecimalValue;
  /** Unit price before VAT, in EGP. */
  unitPrice: DecimalValue;
  internalCode?: string;
};

export type EtaDocumentInput = {
  documentType: "I" | "C";
  version: EtaVersion;
  issuer: EtaParty;
  receiver: EtaParty;
  /** yyyy-MM-ddTHH:mm:ssZ (UTC). */
  dateTimeIssued: string;
  activityCode: string;
  /** Our number: INV-12, CN-0003. */
  internalId: string;
  /** A credit note: the uuids (at ETA) of the invoices it credits. */
  references?: string[];
  lines: EtaLineInput[];
  /** The document's VAT rate, percent (14). */
  vatRate: DecimalValue;
};

/** VAT subtype for a rate: V009 general sales at the standard 14%, V010 other rates, V003 exempt (0%). */
export function vatSubType(rate: Decimal) {
  if (rate.isZero()) return "V003";
  return rate.equals(14) ? "V009" : "V010";
}

/** Text as ETA gets it: no characters whose canonical form is uncertain (quotes, backslashes, control). */
export const etaText = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f"\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function buildEtaDocument(input: EtaDocumentInput) {
  const rate = D(input.vatRate);
  const subType = vatSubType(rate);

  let totalSales = ZERO;
  let netAmount = ZERO;
  let vatTotal = ZERO;
  let totalAmount = ZERO;

  const invoiceLines = input.lines.map((line) => {
    const quantity = D(line.quantity);
    const price = D(line.unitPrice);
    const salesTotal = round5(quantity.times(price));
    const netTotal = salesTotal;
    const vat = round5(netTotal.times(rate).dividedBy(100));
    const total = round5(netTotal.plus(vat));
    totalSales = totalSales.plus(salesTotal);
    netAmount = netAmount.plus(netTotal);
    vatTotal = vatTotal.plus(vat);
    totalAmount = totalAmount.plus(total);
    return {
      description: etaText(line.description).slice(0, 500),
      itemType: line.itemType,
      itemCode: line.itemCode,
      unitType: line.unitType,
      quantity: num(quantity),
      ...(line.internalCode ? { internalCode: etaText(line.internalCode).slice(0, 50) } : {}),
      // EGP: amountSold and the exchange rate are left out ("should not have value otherwise").
      unitValue: { currencySold: "EGP", amountEGP: num(price) },
      salesTotal: num(salesTotal),
      discount: { rate: 0, amount: 0 },
      netTotal: num(netTotal),
      valueDifference: 0,
      totalTaxableFees: 0,
      itemsDiscount: 0,
      taxableItems: [{ taxType: "T1", amount: num(vat), subType, rate: num(rate) }],
      total: num(total),
    };
  });

  const document: Record<string, unknown> = {
    issuer: party(input.issuer),
    receiver: party(input.receiver),
    documentType: input.documentType,
    documentTypeVersion: input.version,
    dateTimeIssued: input.dateTimeIssued,
    taxpayerActivityCode: input.activityCode,
    internalID: input.internalId,
    ...(input.references?.length ? { references: input.references } : {}),
    invoiceLines,
    totalSalesAmount: num(totalSales),
    totalDiscountAmount: 0,
    netAmount: num(netAmount),
    taxTotals: [{ taxType: "T1", amount: num(vatTotal) }],
    extraDiscountAmount: 0,
    totalItemsDiscountAmount: 0,
    totalAmount: num(totalAmount),
  };
  return { document, totalAmount: round5(totalAmount) };
}

/** A party with only the fields that have values (no nulls, no empty optional text). */
function party(p: EtaParty) {
  return {
    type: p.type,
    ...(p.id ? { id: p.id } : {}),
    name: etaText(p.name).slice(0, 100),
    ...(p.address ? { address: address(p.address) } : {}),
  };
}

function address(a: EtaAddress) {
  const out: Record<string, string> = {};
  // ETA's order (issuer's branchID first); optional fields only when filled.
  const keys: (keyof EtaAddress)[] = [
    "branchID",
    "country",
    "governate",
    "regionCity",
    "street",
    "buildingNumber",
    "postalCode",
    "floor",
    "room",
    "landmark",
    "additionalInformation",
  ];
  const required = new Set(["country", "governate", "regionCity", "street", "buildingNumber"]);
  for (const key of keys) {
    const value = a[key];
    if (value === undefined) continue;
    const text = etaText(value);
    if (text || required.has(key)) out[key] = text;
  }
  return out;
}

/**
 * When the document was issued, as ETA wants it: UTC, no milliseconds, never in the future.
 * Issued today: the moment it was issued (a minute back, against clock drift). An earlier
 * date: noon in Cairo that day.
 */
export function etaIssuedAt(issueDate: string, sentAt: Date | null, today: string, now = new Date()) {
  const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (issueDate === today) {
    const at = sentAt && sentAt.getTime() < now.getTime() - 60_000 ? sentAt : new Date(now.getTime() - 60_000);
    return stamp(at);
  }
  // Noon in Cairo is 10:00 or 09:00 UTC; 10:00 UTC is safely that day in Cairo either way.
  return `${issueDate}T10:00:00Z`;
}
