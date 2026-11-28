// Invoice attachments, reminding selected customers, and error alerts to Mizan's staff.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { alertsInTests, reportError, resetErrorAlerts } from "../src/lib/error-alerts.js";
import { businessToday } from "../src/lib/dates.js";
import { testMail } from "../src/lib/mailer.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

// The smallest PNG there is (1x1), and a PDF header.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function customer(token: string, body: Record<string, unknown>) {
  const res = await api().post("/api/customers").set(auth(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.customer as { id: string };
}

async function issuedInvoice(token: string, customerId: string, issueDate = businessToday()) {
  const res = await api()
    .post("/api/invoices")
    .set(auth(token))
    .send({ customerId, issueDate, terms: 30, items: [{ description: "خدمة", quantity: "1", unitPrice: "1000" }], send: true });
  expect(res.status).toBe(201);
  return res.body.invoice as { id: string; number: number };
}

const upload = (token: string, ref: string | number, file: Buffer, name: string) =>
  api()
    .put(`/api/invoices/${ref}/attachments`)
    .set(auth(token))
    .set("Content-Type", "application/octet-stream")
    .set("X-File-Name", encodeURIComponent(name))
    .send(file);

describe("invoice attachments", () => {
  it("added, listed, opened and removed; checked by their bytes; logged", async () => {
    const { token } = await ownerSession();
    const c = await customer(token, { name: "شركة النور" });
    const inv = await issuedInvoice(token, c.id);

    const added = await upload(token, inv.number, PDF, "أمر شراء.pdf");
    expect(added.status).toBe(201);
    expect(added.body.attachment).toMatchObject({ name: "أمر شراء.pdf", contentType: "application/pdf", size: PDF.length });
    expect((await upload(token, inv.id, PNG, "صورة.png")).status).toBe(201);

    // A file that only claims to be a PDF is refused.
    const fake = await upload(token, inv.number, Buffer.from("<html>not a pdf</html>"), "x.pdf");
    expect(fake.status).toBe(415);

    const list = await api().get(`/api/invoices/${inv.number}/attachments`).set(auth(token));
    expect(list.body.attachments.map((a: any) => a.name)).toEqual(["أمر شراء.pdf", "صورة.png"]);

    const file = await api().get(`/api/invoices/${inv.number}/attachments/${added.body.attachment.id}`).set(auth(token)).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-security-policy"]).toContain("sandbox");

    expect((await api().delete(`/api/invoices/${inv.number}/attachments/${added.body.attachment.id}`).set(auth(token))).status).toBe(204);
    expect((await api().get(`/api/invoices/${inv.number}/attachments`).set(auth(token))).body.attachments).toHaveLength(1);
    // The file goes with it.
    expect(await prisma.storedFile.count({ where: { kind: "attachment" } })).toBe(1);

    const events = await prisma.auditEvent.findMany({ where: { event: { startsWith: "invoiceAttachment" } }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.event)).toEqual(["invoiceAttachmentAdded", "invoiceAttachmentAdded", "invoiceAttachmentRemoved"]);
  });

  it("everyone who sees the invoice sees them; adding and removing needs issueInvoices; other companies see nothing", async () => {
    const { token } = await ownerSession();
    const c = await customer(token, { name: "شركة النور" });
    const inv = await issuedInvoice(token, c.id);
    const added = (await upload(token, inv.number, PNG, "a.png")).body.attachment;

    const sales = await teamMember(token, "sales");
    expect((await api().get(`/api/invoices/${inv.number}/attachments`).set(auth(sales.token))).status).toBe(200);
    expect((await upload(sales.token, inv.number, PNG, "b.png")).status).toBe(403);
    expect((await api().delete(`/api/invoices/${inv.number}/attachments/${added.id}`).set(auth(sales.token))).status).toBe(403);

    const other = await ownerSession();
    expect((await api().get(`/api/invoices/${inv.id}/attachments`).set(auth(other.token))).status).toBe(404);
    expect((await api().get(`/api/invoices/${inv.id}/attachments/${added.id}`).set(auth(other.token))).status).toBe(404);
  });
});

describe("reminding the selected customers", () => {
  it("one reminder per unpaid invoice; skips no email, recently reminded, paid and drafts", async () => {
    const { token } = await ownerSession();
    await prisma.user.updateMany({ data: { emailVerifiedAt: new Date() } });
    const withEmail = await customer(token, { name: "شركة النور", email: "nour@example.com" });
    const noEmail = await customer(token, { name: "مكتبة الأمل" });
    const recent = await customer(token, { name: "مصنع الفجر", email: "fajr@example.com" });

    await issuedInvoice(token, withEmail.id);
    await issuedInvoice(token, withEmail.id);
    const paid = await issuedInvoice(token, withEmail.id);
    await api().post(`/api/invoices/${paid.number}/payments`).set(auth(token)).send({ amount: "1140", date: businessToday(), method: "cash" });
    await api().post("/api/invoices").set(auth(token)).send({ customerId: withEmail.id, issueDate: businessToday(), terms: 30, items: [{ description: "x", quantity: "1", unitPrice: "1" }] });
    await issuedInvoice(token, noEmail.id);
    const recentInvoice = await issuedInvoice(token, recent.id);
    await api().post(`/api/invoices/${recentInvoice.number}/email`).set(auth(token)).send({});
    testMail.outbox.length = 0;

    const res = await api().post("/api/customers/bulk-remind").set(auth(token)).send({ ids: [withEmail.id, noEmail.id, recent.id] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 2, noEmail: 1, recent: 1, overLimit: 0, customersReminded: 1 });
    expect(testMail.outbox.map((m) => m.to)).toEqual(["nour@example.com", "nour@example.com"]);
    expect(testMail.outbox[0]!.tag).toBe("reminder");
    expect(await prisma.invoiceEvent.count({ where: { type: "reminderSent" } })).toBe(2);
  });

  it("needs issueInvoices and a confirmed email", async () => {
    const { token } = await ownerSession();
    const c = await customer(token, { name: "شركة النور", email: "nour@example.com" });
    const sales = await teamMember(token, "sales");
    expect((await api().post("/api/customers/bulk-remind").set(auth(sales.token)).send({ ids: [c.id] })).status).toBe(403);
    const unverified = await api().post("/api/customers/bulk-remind").set(auth(token)).send({ ids: [c.id] });
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });
});

describe("error alerts to Mizan's staff", () => {
  it("email each new error once an hour to PLATFORM_ADMIN_EMAILS", async () => {
    alertsInTests.on = true;
    resetErrorAlerts();
    try {
      // The same error from the same line of code (as a real one would be).
      const boom = () => new Error("boom");
      await reportError(boom(), { where: "GET /api/invoices/1044" });
      await reportError(boom(), { where: "GET /api/invoices/1045" });
      await reportError(new Error("other"), { where: "job: notices" });
      const alerts = testMail.outbox.filter((m) => m.tag === "error-alert");
      // Two admins, two different errors (the same one on another invoice counts once).
      expect(alerts).toHaveLength(4);
      expect(alerts.map((m) => m.to).sort()).toEqual(["admin@mizan.test", "admin@mizan.test", "other-admin@mizan.test", "other-admin@mizan.test"]);
      expect(alerts[0]!.subject).toContain("boom");
      expect(alerts[0]!.text).toContain("GET /api/invoices/1044");
    } finally {
      alertsInTests.on = false;
    }
  });
});
