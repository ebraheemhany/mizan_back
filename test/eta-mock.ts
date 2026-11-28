// A stand-in for ETA's identity and e-invoicing APIs, for the tests. It checks what it gets
// the way ETA documents it (structure, string ids, the date format, and every calculation
// equation, recomputed here independently of our builder) and answers in ETA's shapes.
//
// Scenarios: an item code containing "INVALID" is accepted at submission but fails ETA's
// checks (Invalid); a receiver named "REJECT ME" is refused at submission.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

export const MOCK_CLIENT = { id: "test-client", secret: "test-secret" };

type Doc = Record<string, any>;
type Stored = { uuid: string; longId: string; internalId: string; status: string; doc: Doc; problems: unknown[]; cancelRequested: boolean };

const id26 = () => randomBytes(20).toString("base64").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 26).padEnd(26, "X");
const near = (a: number, b: number) => Math.abs(a - b) < 0.000005;
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** ETA's checks on one document: an empty list when it is fine. */
export function etaChecks(doc: Doc): string[] {
  const out: string[] = [];
  const need = (cond: unknown, msg: string) => {
    if (!cond) out.push(msg);
  };
  need(doc.issuer?.type === "B" && typeof doc.issuer?.id === "string" && /^\d{9}$/.test(doc.issuer.id), "issuer.id must be a 9-digit string");
  const a = doc.issuer?.address ?? {};
  need(typeof a.branchID === "string" && a.country === "EG" && a.governate && a.regionCity && a.street && a.buildingNumber, "issuer.address incomplete");
  need(["B", "P", "F"].includes(doc.receiver?.type), "receiver.type");
  if (doc.receiver?.type === "B") need(typeof doc.receiver.id === "string" && /^\d{9}$/.test(doc.receiver.id), "receiver.id must be a 9-digit string");
  if (doc.receiver?.id !== undefined) need(typeof doc.receiver.id === "string", "receiver.id must be a string");
  need(["I", "C", "D", "i", "c", "d"].includes(doc.documentType), "documentType");
  need(["1.0", "0.9"].includes(doc.documentTypeVersion), "documentTypeVersion");
  need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(doc.dateTimeIssued ?? ""), "dateTimeIssued format");
  need(Date.parse(doc.dateTimeIssued) <= Date.now(), "dateTimeIssued in the future");
  need(/^\d{4}$/.test(doc.taxpayerActivityCode ?? ""), "taxpayerActivityCode");
  need(typeof doc.internalID === "string" && doc.internalID.length > 0, "internalID");
  if (/^c$/i.test(doc.documentType)) need(Array.isArray(doc.references) && doc.references.length > 0, "credit note references");
  need(Array.isArray(doc.invoiceLines) && doc.invoiceLines.length > 0, "invoiceLines");

  let sales = 0;
  let disc = 0;
  let net = 0;
  let total = 0;
  const taxes = new Map<string, number>();
  for (const [i, l] of (doc.invoiceLines ?? []).entries()) {
    const at = `line ${i + 1}`;
    need(["GS1", "EGS"].includes(l.itemType) && l.itemCode, `${at}: itemType/itemCode`);
    need(l.unitType, `${at}: unitType`);
    need(typeof l.quantity === "number" && l.quantity > 0, `${at}: quantity`);
    need(l.unitValue?.currencySold === "EGP" && l.unitValue.amountSold === undefined, `${at}: unitValue`);
    for (const k of ["quantity", "salesTotal", "netTotal", "total"]) {
      need(Number.isInteger(Math.round(l[k] * 1e5)) && near(l[k], r5(l[k])), `${at}: ${k} has more than 5 decimals`);
    }
    need(near(l.salesTotal, r5(l.quantity * l.unitValue.amountEGP)), `${at}: salesTotal = quantity × amountEGP`);
    const dAmount = l.discount?.amount ?? 0;
    need(near(l.netTotal, r5(l.salesTotal - dAmount)), `${at}: netTotal = salesTotal − discount`);
    let lineTax = 0;
    for (const t of l.taxableItems ?? []) {
      need(t.subType, `${at}: tax subType`);
      if (t.taxType === "T1") {
        need(near(t.amount, r5((l.netTotal + l.totalTaxableFees + l.valueDifference) * (t.rate / 100))), `${at}: T1 = net × rate`);
        need(t.rate > 0 ? ["V009", "V010"].includes(t.subType) : t.subType.startsWith("V"), `${at}: T1 subtype for its rate`);
      }
      lineTax += t.amount;
      taxes.set(t.taxType, (taxes.get(t.taxType) ?? 0) + t.amount);
    }
    need(near(l.total, r5(l.netTotal + lineTax - l.itemsDiscount)), `${at}: total = net + taxes − itemsDiscount`);
    sales += l.salesTotal;
    disc += dAmount;
    net += l.netTotal;
    total += l.total;
  }
  need(near(doc.totalSalesAmount, r5(sales)), "totalSalesAmount = Σ salesTotal");
  need(near(doc.totalDiscountAmount, r5(disc)), "totalDiscountAmount = Σ discount");
  need(near(doc.netAmount, r5(net)), "netAmount = Σ netTotal");
  for (const t of doc.taxTotals ?? []) need(near(t.amount, r5(taxes.get(t.taxType) ?? 0)), `taxTotals ${t.taxType} = Σ lines`);
  need(near(doc.totalAmount, r5(total - doc.extraDiscountAmount)), "totalAmount = Σ line totals − extra discount");
  return out;
}

/** Starts the mock (a fixed port for browser checks, any free one in the tests). */
export async function startEtaMock(port = 0) {
  const app = express();
  const tokens = new Set<string>();
  const docs = new Map<string, Stored>();
  const submissions = new Map<string, string[]>();
  const recent = new Map<string, number>();
  const received: Doc[] = [];
  const rawBodies: string[] = [];
  let tokenCalls = 0;

  app.use(express.text({ type: "*/*", limit: "5mb" }));
  const authed = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(token)) return res.status(401).json({ error: { code: "Unauthorized", message: "token" } });
    next();
  };

  app.post("/connect/token", (req, res) => {
    tokenCalls++;
    const [id, secret] = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString().split(":");
    const form = new URLSearchParams(String(req.body ?? ""));
    if (id !== MOCK_CLIENT.id || secret !== MOCK_CLIENT.secret || form.get("grant_type") !== "client_credentials") {
      return res.status(400).json({ error: "invalid_client" });
    }
    const token = `tok-${randomBytes(6).toString("hex")}`;
    tokens.add(token);
    res.json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: "InvoicingAPI" });
  });

  app.post("/api/v1.0/documentsubmissions", authed, (req, res) => {
    const raw = String(req.body);
    rawBodies.push(raw);
    // ETA's duplicate guard: the identical payload within 10 minutes.
    const seen = recent.get(raw);
    if (seen && Date.now() - seen < 600_000) return res.status(422).set("Retry-After", "600").json({ error: { code: "DuplicateSubmission" } });
    recent.set(raw, Date.now());
    const body = JSON.parse(raw) as { documents: Doc[] };
    const submissionUUID = id26();
    const accepted: unknown[] = [];
    const rejected: unknown[] = [];
    const uuids: string[] = [];
    for (const doc of body.documents) {
      received.push(doc);
      const problems = etaChecks(doc);
      if (doc.receiver?.name === "REJECT ME") problems.push("receiver refused");
      if (problems.length) {
        rejected.push({
          internalId: doc.internalID,
          error: { code: "BadStructure", message: "Invalid document", target: doc.internalID, details: problems.map((p) => ({ code: "CF001", message: p, target: "document" })) },
        });
        continue;
      }
      const uuid = id26();
      const longId = `${id26()}${id26()}`.slice(0, 42);
      const invalid = (doc.invoiceLines as Doc[]).some((l) => String(l.itemCode).includes("INVALID"));
      docs.set(uuid, {
        uuid,
        longId,
        internalId: doc.internalID,
        status: invalid ? "Invalid" : "Valid",
        doc,
        problems: invalid ? [{ code: "CodeValidator", errorAr: "كود الصنف غير مسجل", message: "Item code not found", propertyPath: "invoiceLines[0].itemCode" }] : [],
        cancelRequested: false,
      });
      uuids.push(uuid);
      accepted.push({ uuid, longId, internalId: doc.internalID });
    }
    submissions.set(submissionUUID, uuids);
    res.status(202).json({ submissionUUID, acceptedDocuments: accepted, rejectedDocuments: rejected });
  });

  app.get("/api/v1.0/documentsubmissions/:id", authed, (req, res) => {
    const uuids = submissions.get(String(req.params.id));
    if (!uuids) return res.status(404).json({ error: { code: "NotFound" } });
    res.json({
      uuid: req.params.id,
      documentCount: uuids.length,
      overallStatus: "Valid",
      documentSummary: uuids.map((u) => ({ uuid: u, longId: docs.get(u)!.longId, internalId: docs.get(u)!.internalId, status: docs.get(u)!.status })),
    });
  });

  app.get("/api/v1.0/documents/:uuid/details", authed, (req, res) => {
    const d = docs.get(String(req.params.uuid));
    if (!d) return res.status(404).json({ error: { code: "NotFound" } });
    res.json({
      status: d.status,
      longId: d.longId,
      cancelRequestDate: d.cancelRequested ? new Date().toISOString() : null,
      document: d.doc,
      validationResults: {
        status: d.status === "Invalid" ? "Invalid" : "Valid",
        validationSteps: [
          { name: "Structure Validator", status: "Valid" },
          { name: "Code Validator", status: d.status === "Invalid" ? "Invalid" : "Valid", error: d.status === "Invalid" ? { innerError: d.problems } : undefined },
        ],
      },
    });
  });

  app.put("/api/v1.0/documents/state/:uuid/state", authed, (req, res) => {
    const d = docs.get(String(req.params.uuid));
    if (!d) return res.status(404).json({ error: { code: "NotFound" } });
    const body = JSON.parse(String(req.body));
    if (body.status !== "cancelled" || !body.reason) return res.status(400).json({ error: { code: "BadArgument" } });
    if (d.status !== "Valid") return res.status(400).json({ error: { code: "IncorrectState" } });
    // A valid credit note pointing at it blocks the invoice's cancellation.
    const referenced = [...docs.values()].some((o) => o.status === "Valid" && (o.doc.references ?? []).includes(d.uuid));
    if (referenced) return res.status(400).json({ error: { code: "ActiveReferencingDocuments", message: "cancel first the referencing document" } });
    d.cancelRequested = true;
    d.status = "Cancelled";
    res.status(200).end();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ETA_PREPROD_ID_URL = base;
  process.env.ETA_PREPROD_API_URL = base;
  process.env.ETA_PREPROD_PORTAL_URL = "https://preprod.invoicing.eta.gov.eg";
  process.env.ETA_POLL_MS = "20";
  return {
    received,
    rawBodies,
    docs,
    tokenCalls: () => tokenCalls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
