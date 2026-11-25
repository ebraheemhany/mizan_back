import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();
const taxes = (extra: Record<string, unknown> = {}) => ({
  taxes: { vatEnabled: true, withholdingEnabled: false, currency: "EGP", fiscalStartMonth: 1, ...extra },
});
const setTaxes = (token: string, extra: Record<string, unknown> = {}) =>
  api().patch("/api/settings").set(auth(token)).send(taxes(extra));
const items = [{ description: "تصميم", quantity: "2", unitPrice: "500" }];

async function customerOf(token: string) {
  return (await api().post("/api/customers").set(auth(token)).send({ name: "شركة النيل" })).body.customer as { id: string };
}
async function invoiceOf(token: string, customerId: string) {
  const res = await api().post("/api/invoices").set(auth(token)).send({ customerId, issueDate: today(), terms: 30, send: true, items });
  expect(res.status).toBe(201);
  return (await api().get(`/api/invoices/${res.body.invoice.number}`).set(auth(token))).body.invoice;
}

describe("the company's VAT rate", () => {
  it("is 14% to start, can be changed, and must be more than 0 and at most 100", async () => {
    const owner = await ownerSession();
    expect((await api().get("/api/settings").set(auth(owner.token))).body.settings.taxes.vatRate).toBe("14.00");

    const saved = await setTaxes(owner.token, { vatRate: "10.5" });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.taxes.vatRate).toBe("10.50");

    for (const bad of ["0", "101", "-5", "abc", "14.555", ""]) {
      const res = await setTaxes(owner.token, { vatRate: bad });
      expect(res.status, `vatRate ${JSON.stringify(bad)}`).toBe(400);
    }
    // Sent without the rate (an older screen), the rate stays.
    await setTaxes(owner.token).expect(200);
    expect((await api().get("/api/settings").set(auth(owner.token))).body.settings.taxes.vatRate).toBe("10.50");
  });

  it("new invoices and quotes get the new rate; earlier ones keep theirs", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const before = await invoiceOf(owner.token, customer.id);
    expect(before).toMatchObject({ vatRate: "14.00", subtotal: "1000.00", vat: "140.00", total: "1140.00" });

    await setTaxes(owner.token, { vatRate: "5" }).expect(200);
    const after = await invoiceOf(owner.token, customer.id);
    expect(after).toMatchObject({ vatRate: "5.00", vat: "50.00", total: "1050.00" });
    const again = (await api().get(`/api/invoices/${before.number}`).set(auth(owner.token))).body.invoice;
    expect(again).toMatchObject({ vatRate: "14.00", vat: "140.00", total: "1140.00" });

    const quote = await api()
      .post("/api/quotes")
      .set(auth(owner.token))
      .send({ customerId: customer.id, issueDate: today(), validUntil: addDays(today(), 30), items });
    expect(quote.status).toBe(201);
    const detail = (await api().get(`/api/quotes/${quote.body.quote.number}`).set(auth(owner.token))).body.quote;
    expect(detail).toMatchObject({ vatRate: "5.00", vat: "50.00" });

    // VAT off: no VAT at all, whatever the rate.
    await api().patch("/api/settings").set(auth(owner.token)).send(taxes({ vatEnabled: false })).expect(200);
    expect(await invoiceOf(owner.token, customer.id)).toMatchObject({ vatRate: "0.00", vat: "0.00" });
  });

  it("the VAT report shows the rate, or each rate when it changed within the period", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const report = async () => (await api().get("/api/reports/vat").set(auth(owner.token))).body.vat;

    // Nothing issued yet: the company's rate.
    await setTaxes(owner.token, { vatRate: "12" }).expect(200);
    expect(await report()).toMatchObject({ rate: 12, rates: [] });

    await invoiceOf(owner.token, customer.id);
    expect(await report()).toMatchObject({ rate: 12, rates: [12], output: "120.00" });

    await setTaxes(owner.token, { vatRate: "14" }).expect(200);
    await invoiceOf(owner.token, customer.id);
    expect(await report()).toMatchObject({ rate: null, rates: [12, 14], output: "260.00" });
  });
});
