import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessToday } from "../src/lib/dates.js";
import { testMail } from "../src/lib/mailer.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const today = () => businessToday();

/** An owner whose email is confirmed (only they may email customers). */
async function verifiedOwner() {
  const owner = await ownerSession();
  await prisma.user.update({ where: { id: owner.userId }, data: { emailVerifiedAt: new Date() } });
  return owner;
}

async function customerOf(token: string, body: Record<string, unknown> = {}) {
  const res = await api().post("/api/customers").set(auth(token)).send({ name: "شركة النيل", email: "billing@nile.example", ...body });
  return res.body.customer as { id: string };
}

async function invoiceFor(token: string, customerId: string, body: Record<string, unknown> = {}) {
  const res = await api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate: today(), terms: 30, send: true, items: [{ description: "خدمة", quantity: "1", unitPrice: "1000" }], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.invoice as { id: string; number: number };
}

const sent = (tag: string) => testMail.outbox.filter((m) => m.tag === tag);

describe("emailing an invoice", () => {
  it("goes to the customer through Mizan in the company's name, replies to the sender, links its page; recorded and logged", async () => {
    const owner = await verifiedOwner();
    const customer = await customerOf(owner.token);
    const invoice = await invoiceFor(owner.token, customer.id);

    const res = await api().post(`/api/invoices/${invoice.number}/email`).set(auth(owner.token)).send({});
    expect(res.status).toBe(200);
    const [mail] = sent("invoice");
    expect(mail).toMatchObject({ to: "billing@nile.example", replyTo: owner.email });
    // The inbox shows Mizan (MAIL_FROM's name) as the sender; the subject names the company.
    expect(mail!.fromName).toBeUndefined();
    expect(mail!.subject).toBe(`فاتورة INV-${invoice.number} من شركة ميزان`);
    // Mizan heads the email; the company is named in the text.
    expect(mail!.html).toContain(">ميزان</p>");
    const { publicToken } = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(mail!.text).toContain(`http://localhost:3000/ar/i/${publicToken}`);
    // 1000 + 14% VAT.
    expect(mail!.text).toContain("1,140");
    expect(mail!.text).toContain("أهلاً شركة النيل،");

    expect(res.body.invoice.history[0]).toMatchObject({ type: "emailed", values: { to: "billing@nile.example" } });
    const log = await api().get("/api/audit?action=send").set(auth(owner.token));
    expect(log.body.items[0]).toMatchObject({ event: "invoiceEmailed", values: { to: "billing@nile.example" } });
  });

  it("another address, an own message (escaped), English; Mizan at the top, not the company logo", async () => {
    const owner = await verifiedOwner();
    const customer = await customerOf(owner.token);
    const invoice = await invoiceFor(owner.token, customer.id);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const logo = await api().put("/api/settings/logo").set(auth(owner.token)).set("Content-Type", "image/png").send(png);

    await api()
      .post(`/api/invoices/${invoice.id}/email`)
      .set(auth(owner.token))
      .send({ to: "Accounts@Nile.example", message: "Dear team,\n\n<b>please</b> pay", locale: "en" })
      .expect(200);
    const [mail] = sent("invoice");
    expect(mail!.to).toBe("accounts@nile.example");
    expect(mail!.subject).toBe(`Invoice INV-${invoice.number} from شركة ميزان`);
    expect(mail!.text).toContain("/en/i/");
    expect(mail!.html).toContain("&lt;b&gt;please&lt;/b&gt;");
    expect(mail!.html).not.toContain("Hello");
    expect(mail!.html).not.toContain(`/api/public/logos/${logo.body.logoId}`);
    expect(mail!.html).toContain(">Mizan</p>");
  });

  it("refused: unconfirmed sender, a draft, no address, viewers; a failed send records nothing", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token, { email: undefined, name: "بدون إيميل" });
    const invoice = await invoiceFor(owner.token, customer.id);
    const draft = await invoiceFor(owner.token, customer.id, { send: false });

    const unconfirmed = await api().post(`/api/invoices/${invoice.number}/email`).set(auth(owner.token)).send({});
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    await prisma.user.update({ where: { id: owner.userId }, data: { emailVerifiedAt: new Date() } });
    const noAddress = await api().post(`/api/invoices/${invoice.number}/email`).set(auth(owner.token)).send({});
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.error.code).toBe("NO_CUSTOMER_EMAIL");
    const notIssued = await api().post(`/api/invoices/${draft.number}/email`).set(auth(owner.token)).send({ to: "a@b.example" });
    expect(notIssued.status).toBe(409);
    expect(notIssued.body.error.code).toBe("INVOICE_NOT_EMAILABLE");

    const viewer = await teamMember(owner.token, "viewer");
    expect((await api().post(`/api/invoices/${invoice.number}/email`).set(auth(viewer.token)).send({ to: "a@b.example" })).status).toBe(403);

    testMail.fail = true;
    const failed = await api().post(`/api/invoices/${invoice.number}/email`).set(auth(owner.token)).send({ to: "a@b.example" });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("EMAIL_FAILED");
    expect(await prisma.invoiceEvent.count({ where: { invoiceId: invoice.id, type: "emailed" } })).toBe(0);
    expect(sent("invoice")).toHaveLength(0);
  });
});

describe("payment reminders", () => {
  it("by email: the user's words, an overdue subject, recorded with the address", async () => {
    const owner = await verifiedOwner();
    const customer = await customerOf(owner.token);
    const invoice = await invoiceFor(owner.token, customer.id, { issueDate: addDays(today(), -40), terms: 15 });

    const res = await api()
      .post(`/api/invoices/${invoice.number}/reminders`)
      .set(auth(owner.token))
      .send({ channel: "email", message: "أهلاً،\nبنفكركم بالفاتورة.", recipient: "ignored" });
    expect(res.status).toBe(201);
    const [mail] = sent("reminder");
    expect(mail!.subject).toBe(`الفاتورة INV-${invoice.number} من شركة ميزان متأخرة`);
    expect(mail!.text).toContain("بنفكركم بالفاتورة.");
    expect(mail!.to).toBe("billing@nile.example");
    expect(res.body.invoice.history[0]).toMatchObject({ type: "reminderSent", values: { channel: "email", to: "billing@nile.example" } });
  });

  it("by WhatsApp nothing is emailed, and no confirmed address is needed", async () => {
    const owner = await ownerSession();
    const customer = await customerOf(owner.token);
    const invoice = await invoiceFor(owner.token, customer.id);
    const res = await api()
      .post(`/api/invoices/${invoice.number}/reminders`)
      .set(auth(owner.token))
      .send({ channel: "whatsapp", recipient: "01000000000", message: "تذكير" });
    expect(res.status).toBe(201);
    expect(testMail.outbox.filter((m) => m.tag === "reminder")).toHaveLength(0);
  });
});

describe("emailing a quote", () => {
  async function quoteFor(token: string, customerId: string, send = true) {
    const res = await api()
      .post("/api/quotes")
      .set(auth(token))
      .send({ customerId, issueDate: today(), validUntil: addDays(today(), 14), send, items: [{ description: "توريد", quantity: "2", unitPrice: "1500" }] });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.quote as { id: string; number: number };
  }

  it("a sent quote goes with its answer link; drafts and answered quotes don't", async () => {
    const owner = await verifiedOwner();
    const customer = await customerOf(owner.token);
    const quote = await quoteFor(owner.token, customer.id);

    const res = await api().post(`/api/quotes/${quote.number}/email`).set(auth(owner.token)).send({ locale: "en" });
    expect(res.status).toBe(200);
    const [mail] = sent("quote");
    expect(mail!.subject).toBe(`Quote Q-${quote.number} from شركة ميزان`);
    const { publicToken } = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(mail!.text).toContain(`http://localhost:3000/en/share/quotes/${publicToken}`);
    expect(res.body.quote.history[0]).toMatchObject({ type: "emailed" });

    const draft = await quoteFor(owner.token, customer.id, false);
    expect((await api().post(`/api/quotes/${draft.number}/email`).set(auth(owner.token)).send({})).body.error.code).toBe(
      "QUOTE_NOT_EMAILABLE",
    );
    await api().post(`/api/quotes/${quote.number}/accept`).set(auth(owner.token)).expect(200);
    expect((await api().post(`/api/quotes/${quote.number}/email`).set(auth(owner.token)).send({})).status).toBe(409);
  });
});
