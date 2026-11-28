// ETA's canonical form (what's hashed and signed) and the document builder, checked against
// the SDK's own vectors (https://sdk.invoicing.eta.gov.eg/files/one-doc.json and
// one-doc-serialized.json.txt) and a worked VAT-only invoice.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { etaCanonical } from "../src/modules/eta/eta.canonical.js";
import { buildEtaDocument, etaIssuedAt, vatSubType } from "../src/modules/eta/eta.document.js";
import { Prisma } from "../src/generated/prisma/client.js";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/eta/${name}`, import.meta.url), "utf8").replace(/^﻿/, "");
const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/** JSON.parse keeping each number's exact text (as a string: its canonical form is the same). */
const parseKeepingNumbers = (text: string) =>
  JSON.parse(text, (_key, value, context?: { source?: string }) => (typeof value === "number" ? (context?.source ?? String(value)) : value));

describe("ETA canonical form", () => {
  it("matches the SDK's serialized sample byte for byte, and its hash", () => {
    const sample = parseKeepingNumbers(fixture("one-doc.json"));
    const document = sample.documents ? sample.documents[0] : sample;
    const canonical = etaCanonical(document);
    expect(canonical).toBe(fixture("one-doc-serialized.json.txt"));
    // The messageDigest inside the SDK's signed copy of this document.
    expect(sha256(canonical)).toBe("d43fae25b02b7e466fa5aa39e5fa45c7d92661e5b0a0e7964e04783bff3c2651");
  });

  it("nested objects, arrays (name before each element), number text kept, signatures left out", () => {
    const doc = parseKeepingNumbers(
      '{"issuer":{"type":"B","id":"123456789"},"quantity":2.50,"taxableItems":[{"taxType":"T1","amount":14.00,"rate":14},{"taxType":"T4","amount":0}],"references":["UUID1","UUID2"],"signatures":[{"signatureType":"I","value":"MIIG..."}]}',
    );
    expect(etaCanonical(doc)).toBe(
      '"ISSUER""TYPE""B""ID""123456789""QUANTITY""2.50""TAXABLEITEMS""TAXABLEITEMS""TAXTYPE""T1""AMOUNT""14.00""RATE""14""TAXABLEITEMS""TAXTYPE""T4""AMOUNT""0""REFERENCES""REFERENCES""UUID1""REFERENCES""UUID2"',
    );
  });
});

describe("ETA document builder", () => {
  const input = {
    documentType: "I" as const,
    version: "1.0" as const,
    issuer: {
      type: "B" as const,
      id: "123456789",
      name: "Mizan Demo Co",
      address: { branchID: "0", country: "EG", governate: "Cairo", regionCity: "Nasr City", street: "Abbas El Akkad", buildingNumber: "12" },
    },
    receiver: {
      type: "B" as const,
      id: "987654321",
      name: "Client Co",
      address: { country: "EG", governate: "Giza", regionCity: "Dokki", street: "Tahrir St", buildingNumber: "5" },
    },
    dateTimeIssued: "2026-11-28T10:00:00Z",
    activityCode: "6201",
    internalId: "INV-2026-0001",
    vatRate: "14",
    lines: [
      { description: "Laptop stand", itemType: "EGS" as const, itemCode: "EG-123456789-STAND01", unitType: "EA", quantity: "3", unitPrice: "150", internalCode: "STAND01" },
      { description: "Setup service", itemType: "EGS" as const, itemCode: "EG-123456789-SETUP", unitType: "HUR", quantity: "2.5", unitPrice: "34.58", internalCode: "SETUP" },
    ],
  };

  it("builds the worked VAT-only invoice exactly: values, field order, canonical form and hash", () => {
    const { document, totalAmount } = buildEtaDocument(input);
    const json = JSON.stringify(document);
    expect(json).toBe(
      '{"issuer":{"type":"B","id":"123456789","name":"Mizan Demo Co","address":{"branchID":"0","country":"EG","governate":"Cairo","regionCity":"Nasr City","street":"Abbas El Akkad","buildingNumber":"12"}},"receiver":{"type":"B","id":"987654321","name":"Client Co","address":{"country":"EG","governate":"Giza","regionCity":"Dokki","street":"Tahrir St","buildingNumber":"5"}},"documentType":"I","documentTypeVersion":"1.0","dateTimeIssued":"2026-11-28T10:00:00Z","taxpayerActivityCode":"6201","internalID":"INV-2026-0001","invoiceLines":[{"description":"Laptop stand","itemType":"EGS","itemCode":"EG-123456789-STAND01","unitType":"EA","quantity":3,"internalCode":"STAND01","unitValue":{"currencySold":"EGP","amountEGP":150},"salesTotal":450,"discount":{"rate":0,"amount":0},"netTotal":450,"valueDifference":0,"totalTaxableFees":0,"itemsDiscount":0,"taxableItems":[{"taxType":"T1","amount":63,"subType":"V009","rate":14}],"total":513},{"description":"Setup service","itemType":"EGS","itemCode":"EG-123456789-SETUP","unitType":"HUR","quantity":2.5,"internalCode":"SETUP","unitValue":{"currencySold":"EGP","amountEGP":34.58},"salesTotal":86.45,"discount":{"rate":0,"amount":0},"netTotal":86.45,"valueDifference":0,"totalTaxableFees":0,"itemsDiscount":0,"taxableItems":[{"taxType":"T1","amount":12.103,"subType":"V009","rate":14}],"total":98.553}],"totalSalesAmount":536.45,"totalDiscountAmount":0,"netAmount":536.45,"taxTotals":[{"taxType":"T1","amount":75.103}],"extraDiscountAmount":0,"totalItemsDiscountAmount":0,"totalAmount":611.553}',
    );
    expect(sha256(etaCanonical(document))).toBe("db1d47bfeb4f150cfd6cd094f911bfb0d6efa8e8a82426ceb51dffe750b46392");
    expect(totalAmount.toString()).toBe("611.553");
  });

  it("keeps every value to 5 decimals with no float noise; VAT subtypes by rate", () => {
    // 1.333 × 10.25 = 13.66325 exactly; × 14% = 1.912855 → 1.91286 (5 dp).
    const { document } = buildEtaDocument({ ...input, lines: [{ ...input.lines[0]!, quantity: "1.333", unitPrice: "10.25" }] });
    const line = (document.invoiceLines as any[])[0];
    expect(line).toMatchObject({ salesTotal: 13.66325, netTotal: 13.66325, total: 15.57611 });
    expect(line.taxableItems[0]).toEqual({ taxType: "T1", amount: 1.91286, subType: "V009", rate: 14 });
    expect(vatSubType(new Prisma.Decimal(0))).toBe("V003");
    expect(vatSubType(new Prisma.Decimal(5))).toBe("V010");
    // Credit notes carry the invoices they credit.
    const note = buildEtaDocument({ ...input, documentType: "C", references: ["5Z40TP7SXAKADVH8WX71PXNE10"] }).document;
    expect(Object.keys(note).indexOf("references")).toBe(Object.keys(note).indexOf("internalID") + 1);
  });

  it("text goes without characters whose canonical form is uncertain; empty optional address fields are left out", () => {
    const { document } = buildEtaDocument({
      ...input,
      receiver: { type: "P", name: 'Ali "the boss"\n\\', address: { country: "EG", governate: "", regionCity: "", street: "", buildingNumber: "", floor: "" } },
    });
    expect(document.receiver).toEqual({
      type: "P",
      name: "Ali the boss",
      address: { country: "EG", governate: "", regionCity: "", street: "", buildingNumber: "" },
    });
  });

  it("issue time: today → when it was issued (never in the future); an earlier day → that day, UTC", () => {
    const now = new Date("2026-11-28T12:00:30.123Z");
    expect(etaIssuedAt("2026-11-28", new Date("2026-11-28T09:15:10.500Z"), "2026-11-28", now)).toBe("2026-11-28T09:15:10Z");
    expect(etaIssuedAt("2026-11-28", new Date("2026-11-28T12:00:10Z"), "2026-11-28", now)).toBe("2026-11-28T11:59:30Z");
    expect(etaIssuedAt("2026-11-20", null, "2026-11-28", now)).toBe("2026-11-20T10:00:00Z");
  });
});
