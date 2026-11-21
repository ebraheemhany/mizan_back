import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { businessToday } from "../src/lib/dates.js";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

// A real 1×1 PNG, a tiny PDF, and an HTML page pretending to be an image.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const FAKE = Buffer.from("<html><script>alert(1)</script></html>");

/** Reads any response as raw bytes. */
const asBytes = (res: NodeJS.ReadableStream, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};

const upload = (token: string, path: string, data: Buffer, type: string, name?: string) => {
  const req = api().put(path).set(auth(token)).set("Content-Type", type);
  if (name) req.set("X-File-Name", encodeURIComponent(name));
  return req.send(data);
};

async function expenseOf(token: string) {
  const res = await api()
    .post("/api/expenses")
    .set(auth(token))
    .send({ title: "إيجار", category: "rent", amount: "3000", date: businessToday(), status: "paid", paidFrom: "bank" });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.expense as { id: string };
}

describe("company logo", () => {
  it("uploaded by the owner, shown to anyone by its id, on invoices too; replaced and removed", async () => {
    const { token } = await ownerSession();
    const first = await upload(token, "/api/settings/logo", PNG, "image/png", "شعار.png");
    expect(first.status).toBe(200);
    const logoId = first.body.logoId as string;
    expect((await api().get("/api/settings").set(auth(token))).body.settings.company.logoId).toBe(logoId);

    // No login needed; cacheable; shown from other origins; never sniffed.
    const shown = await api().get(`/api/public/logos/${logoId}`).buffer(true).parse(asBytes);
    expect(shown.status).toBe(200);
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["cache-control"]).toContain("immutable");
    expect(shown.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(shown.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(shown.body as Buffer, PNG)).toBe(0);

    // On the invoice (and so its print and public page).
    const customer = (await api().post("/api/customers").set(auth(token)).send({ name: "عميل" })).body.customer;
    const invoice = (await api().post("/api/invoices").set(auth(token)).send({
      customerId: customer.id,
      issueDate: businessToday(),
      terms: 30,
      send: true,
      items: [{ description: "خدمة", quantity: "1", unitPrice: "100" }],
    })).body.invoice;
    expect((await api().get(`/api/invoices/${invoice.id}`).set(auth(token))).body.invoice.issuer.logoId).toBe(logoId);

    // Replacing it drops the old file.
    const second = await upload(token, "/api/settings/logo", PNG, "image/png");
    expect(second.body.logoId).not.toBe(logoId);
    expect((await api().get(`/api/public/logos/${logoId}`)).status).toBe(404);
    expect(await prisma.storedFile.count()).toBe(1);

    expect((await api().delete("/api/settings/logo").set(auth(token))).status).toBe(204);
    expect((await api().get("/api/settings").set(auth(token))).body.settings.company.logoId).toBeNull();
    expect((await api().get(`/api/public/logos/${second.body.logoId}`)).status).toBe(404);
    expect(await prisma.storedFile.count()).toBe(0);
  });

  it("only images, only up to 1 MB, only the owner; the type is read from the file itself", async () => {
    const { token } = await ownerSession();
    const accountant = await teamMember(token, "accountant");

    const disguised = await upload(token, "/api/settings/logo", FAKE, "image/png");
    expect(disguised.status).toBe(415);
    expect(disguised.body.error.code).toBe("FILE_TYPE");
    expect((await upload(token, "/api/settings/logo", PDF, "application/pdf")).body.error.code).toBe("FILE_TYPE");
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    expect((await upload(token, "/api/settings/logo", big, "image/png")).body.error.code).toBe("FILE_TOO_LARGE");
    const huge = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]);
    const tooHuge = await upload(token, "/api/settings/logo", huge, "image/png");
    expect(tooHuge.status).toBe(413);
    expect(tooHuge.body.error.code).toBe("FILE_TOO_LARGE");
    expect((await api().put("/api/settings/logo").set(auth(token)).send()).body.error.code).toBe("FILE_EMPTY");
    expect((await upload(accountant.token, "/api/settings/logo", PNG, "image/png")).status).toBe(403);
    expect(await prisma.storedFile.count()).toBe(0);
  });
});

describe("expense receipts", () => {
  it("attached, read back with the right type, replaced, removed, and deleted with the expense", async () => {
    const { token } = await ownerSession();
    const expense = await expenseOf(token);

    const attached = await upload(token, `/api/expenses/${expense.id}/receipt`, PDF, "application/pdf", "فاتورة الإيجار.pdf");
    expect(attached.status).toBe(200);
    expect(attached.body.receipt).toEqual({ contentType: "application/pdf", size: PDF.length, name: "فاتورة الإيجار.pdf" });
    const { items } = (await api().get("/api/expenses").set(auth(token))).body;
    expect(items[0].receipt).toEqual({ contentType: "application/pdf", size: PDF.length, name: "فاتورة الإيجار.pdf" });

    const read = await api().get(`/api/expenses/${expense.id}/receipt`).set(auth(token)).buffer(true).parse(asBytes);
    expect(read.status).toBe(200);
    expect(read.headers["content-type"]).toBe("application/pdf");
    expect(read.headers["cache-control"]).toContain("no-store");
    expect(read.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(Buffer.compare(read.body as Buffer, PDF)).toBe(0);

    // A photo instead.
    const photo = await upload(token, `/api/expenses/${expense.id}/receipt`, PNG, "image/png");
    expect(photo.body.receipt.contentType).toBe("image/png");
    expect(await prisma.storedFile.count()).toBe(1);

    expect((await api().delete(`/api/expenses/${expense.id}/receipt`).set(auth(token))).status).toBe(204);
    expect((await api().get(`/api/expenses/${expense.id}/receipt`).set(auth(token))).status).toBe(404);

    await upload(token, `/api/expenses/${expense.id}/receipt`, PNG, "image/png");
    expect((await api().delete(`/api/expenses/${expense.id}`).set(auth(token))).status).toBe(204);
    expect(await prisma.storedFile.count()).toBe(0);
  });

  it("another company's, sales, and odd files are refused; it goes in the audit log", async () => {
    const { token } = await ownerSession();
    const other = await ownerSession();
    const sales = await teamMember(token, "sales");
    const expense = await expenseOf(token);
    await upload(token, `/api/expenses/${expense.id}/receipt`, PNG, "image/png");

    expect((await api().get(`/api/expenses/${expense.id}/receipt`).set(auth(other.token))).status).toBe(404);
    expect((await upload(other.token, `/api/expenses/${expense.id}/receipt`, PNG, "image/png")).status).toBe(404);
    expect((await api().get(`/api/expenses/${expense.id}/receipt`).set(auth(sales.token))).status).toBe(403);
    expect((await upload(token, `/api/expenses/${expense.id}/receipt`, FAKE, "application/pdf")).body.error.code).toBe("FILE_TYPE");
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(token, `/api/expenses/${expense.id}/receipt`, big, "application/pdf")).body.error.code).toBe("FILE_TOO_LARGE");

    const { items } = (await api().get("/api/audit?action=update").set(auth(token))).body;
    expect(items[0]).toMatchObject({ event: "receiptAttached", item: { type: "expense", ref: "إيجار" } });
  });
});
