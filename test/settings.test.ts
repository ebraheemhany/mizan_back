import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const fullSettings = {
  company: {
    name: "شركة ميزان للحلول",
    taxNumber: "412-558-903",
    commercialRegister: "88214",
    phone: "01050931447",
    address: "الجيزة، مصر",
  },
  taxes: { vatEnabled: true, withholdingEnabled: true, currency: "USD", fiscalStartMonth: 7 },
  numbering: { invoicePrefix: "INV-", invoiceNext: 1044, quotePrefix: "Q-", quoteNext: 213, paymentTermsDays: 45 },
  template: { style: "modern", footer: "شكراً لتعاملكم معنا." },
  notifications: { overdueInvoice: false, newPayment: true, taskReminder: true, weeklyDigest: true },
  integrations: { whatsapp: true, paymentGateway: false, eta: false, calendar: true },
};

/** What comes back: the same, plus the logo (uploaded separately; none here). */
const savedSettings = { ...fullSettings, company: { ...fullSettings.company, logoId: null } };

const get = (token: string) => api().get("/api/settings").set(auth(token));
const patch = (token: string, body: unknown) => api().patch("/api/settings").set(auth(token)).send(body);

describe("GET /api/settings", () => {
  it("a new company starts with sensible defaults", async () => {
    const owner = await ownerSession();
    const res = await get(owner.token);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      company: { name: "شركة ميزان", taxNumber: null, commercialRegister: null, phone: null, address: null, logoId: null },
      taxes: { vatEnabled: true, withholdingEnabled: false, currency: "EGP", fiscalStartMonth: 1 },
      numbering: { invoicePrefix: "INV-", invoiceNext: 1, quotePrefix: "Q-", quoteNext: 1, paymentTermsDays: 30 },
      template: { style: "classic", footer: null },
      notifications: { overdueInvoice: true, newPayment: true, taskReminder: true, weeklyDigest: false },
      integrations: { whatsapp: false, paymentGateway: false, eta: false, calendar: false },
    });
  });

  it("every role can read them", async () => {
    const owner = await ownerSession();
    for (const role of ["accountant", "sales", "viewer"]) {
      const member = await teamMember(owner.token, role);
      expect((await get(member.token)).status).toBe(200);
    }
    expect((await api().get("/api/settings")).status).toBe(401);
  });
});

describe("PATCH /api/settings", () => {
  it("saves every section and returns them", async () => {
    const owner = await ownerSession();
    const res = await patch(owner.token, fullSettings);
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual(savedSettings);
    expect((await get(owner.token)).body.settings).toEqual(savedSettings);
  });

  it("saves only the sections sent", async () => {
    const owner = await ownerSession();
    await patch(owner.token, fullSettings);
    const res = await patch(owner.token, { taxes: { ...fullSettings.taxes, currency: "SAR" } });
    expect(res.body.settings.taxes.currency).toBe("SAR");
    expect(res.body.settings.numbering).toEqual(fullSettings.numbering);
    expect(res.body.settings.company).toEqual(savedSettings.company);
  });

  it("the session carries the company's currency, so the app shows amounts in it", async () => {
    const owner = await ownerSession();
    const me = async () => (await api().get("/api/auth/me").set(auth(owner.token))).body.user.company;
    expect((await me()).currency).toBe("EGP");
    await patch(owner.token, { taxes: { ...fullSettings.taxes, currency: "SAR" } });
    expect(await me()).toMatchObject({ currency: "SAR" });
  });

  it("empty optional fields are cleared", async () => {
    const owner = await ownerSession();
    await patch(owner.token, fullSettings);
    const res = await patch(owner.token, {
      company: { ...fullSettings.company, taxNumber: "", address: "  " },
      template: { style: "classic", footer: "" },
    });
    expect(res.body.settings.company).toMatchObject({ taxNumber: null, address: null, phone: "01050931447" });
    expect(res.body.settings.template.footer).toBeNull();
  });

  it("renaming the company shows up in /me", async () => {
    const owner = await ownerSession();
    await patch(owner.token, { company: { ...fullSettings.company, name: "اسم جديد" } });
    const me = await api().get("/api/auth/me").set(auth(owner.token));
    expect(me.body.user.company.name).toBe("اسم جديد");
  });

  it("only the owner can change them", async () => {
    const owner = await ownerSession();
    for (const role of ["accountant", "sales", "viewer"]) {
      const member = await teamMember(owner.token, role);
      const res = await patch(member.token, { taxes: fullSettings.taxes });
      expect(res.status).toBe(403);
    }
    expect((await get(owner.token)).body.settings.taxes.currency).toBe("EGP");
  });

  it("validates every field", async () => {
    const owner = await ownerSession();
    const bad: [string, unknown][] = [
      ["empty name", { company: { ...fullSettings.company, name: "" } }],
      ["tax number", { company: { ...fullSettings.company, taxNumber: "12345" } }],
      ["register", { company: { ...fullSettings.company, commercialRegister: "AB12" } }],
      ["phone", { company: { ...fullSettings.company, phone: "call me" } }],
      ["currency", { taxes: { ...fullSettings.taxes, currency: "EUR" } }],
      ["month", { taxes: { ...fullSettings.taxes, fiscalStartMonth: 13 } }],
      ["prefix", { numbering: { ...fullSettings.numbering, invoicePrefix: "INV 2026/" } }],
      ["next number", { numbering: { ...fullSettings.numbering, invoiceNext: 0 } }],
      ["payment terms", { numbering: { ...fullSettings.numbering, paymentTermsDays: 20 } }],
      ["template", { template: { style: "fancy", footer: "" } }],
      ["footer", { template: { style: "classic", footer: "x".repeat(201) } }],
      ["incomplete section", { taxes: { currency: "USD" } }],
      ["unknown field", { company: { ...fullSettings.company, color: "red" } }],
      ["unknown section", { theme: { dark: true } }],
      ["nothing sent", {}],
    ];
    for (const [label, body] of bad) {
      const res = await patch(owner.token, body);
      expect(res.status, label).toBe(400);
    }
    expect((await get(owner.token)).body.settings.taxes.currency).toBe("EGP");
  });

  it("each company has its own settings", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    await patch(owner.token, fullSettings);
    expect((await get(other.token)).body.settings.taxes.currency).toBe("EGP");
    expect((await get(other.token)).body.settings.numbering.invoiceNext).toBe(1);
  });
});
