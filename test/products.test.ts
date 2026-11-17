import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api, auth, ownerSession, prisma, resetDatabase, teamMember } from "./helpers.js";

beforeEach(resetDatabase);
afterAll(() => prisma.$disconnect());

const service = { name: "تطوير موقع", type: "service", code: "srv-001", price: "25000", taxRate: "14", category: "software" };
const product = { name: "راوتر WiFi 6", type: "product", code: "PRD-014", price: 1850.5, taxRate: 14, category: "network", stock: 42, lowStockAt: 10 };

async function create(token: string, body: Record<string, unknown>) {
  const res = await api().post("/api/products").set(auth(token)).send(body);
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.product as { id: string; code: string };
}

const list = (token: string, query = "") => api().get(`/api/products${query}`).set(auth(token));
const codes = (res: { body: { items: { code: string }[] } }) => res.body.items.map((p) => p.code);

describe("POST /api/products", () => {
  it("creates a service: code uppercased, money as 2-decimal strings, no stock", async () => {
    const owner = await ownerSession();
    const res = await api().post("/api/products").set(auth(owner.token)).send({ ...service, stock: 99 });
    expect(res.status).toBe(201);
    expect(res.body.product).toMatchObject({
      code: "SRV-001",
      price: "25000.00",
      taxRate: "14.00",
      stock: null,
      lowStockAt: null,
      usageCount: 0,
    });
  });

  it("creates a product with stock (number inputs accepted)", async () => {
    const owner = await ownerSession();
    const res = await api().post("/api/products").set(auth(owner.token)).send(product);
    expect(res.body.product).toMatchObject({ price: "1850.50", stock: 42, lowStockAt: 10 });

    const noStock = await api()
      .post("/api/products")
      .set(auth(owner.token))
      .send({ ...product, code: "PRD-015", stock: undefined, lowStockAt: undefined });
    expect(noStock.body.product).toMatchObject({ stock: 0, lowStockAt: 0 });
  });

  it("keeps money exact (no floating point drift)", async () => {
    const owner = await ownerSession();
    const res = await api().post("/api/products").set(auth(owner.token)).send({ ...service, price: "999999999999.99" });
    expect(res.body.product.price).toBe("999999999999.99");
  });

  it("validates the fields", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/products")
      .set(auth(owner.token))
      .send({ name: "", type: "thing", code: "", price: "-5", taxRate: "150", category: "food", stock: -1 });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details.fieldErrors).sort()).toEqual(
      ["category", "code", "name", "price", "stock", "taxRate", "type"].sort(),
    );

    for (const price of ["1.234", "abc", ""]) {
      expect((await api().post("/api/products").set(auth(owner.token)).send({ ...service, price })).status).toBe(400);
    }
  });

  it("refuses a code already used in the company (any letter case), but not in another company", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    await create(owner.token, service);

    const dup = await api().post("/api/products").set(auth(owner.token)).send({ ...service, code: "Srv-001" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CODE_TAKEN");

    expect((await api().post("/api/products").set(auth(other.token)).send(service)).status).toBe(201);
  });
});

describe("permissions by role", () => {
  it("everyone can view; owner and accountant can edit; only the owner can delete", async () => {
    const owner = await ownerSession();
    const item = await create(owner.token, service);
    const accountant = await teamMember(owner.token, "accountant");
    const sales = await teamMember(owner.token, "sales");
    const viewer = await teamMember(owner.token, "viewer");

    for (const { token } of [owner, accountant, sales, viewer]) {
      expect((await list(token)).status).toBe(200);
      expect((await api().get(`/api/products/${item.id}`).set(auth(token))).status).toBe(200);
    }

    const editRules: [string, boolean][] = [
      [owner.token, true],
      [accountant.token, true],
      [sales.token, false],
      [viewer.token, false],
    ];
    for (const [token, allowed] of editRules) {
      const create = await api()
        .post("/api/products")
        .set(auth(token))
        .send({ ...service, code: `X-${Math.random().toString(36).slice(2, 8)}` });
      expect(create.status).toBe(allowed ? 201 : 403);
      const patch = await api().patch(`/api/products/${item.id}`).set(auth(token)).send({ price: "100" });
      expect(patch.status).toBe(allowed ? 200 : 403);
    }

    for (const { token } of [accountant, sales, viewer]) {
      expect((await api().delete(`/api/products/${item.id}`).set(auth(token))).status).toBe(403);
    }
    expect((await api().delete(`/api/products/${item.id}`).set(auth(owner.token))).status).toBe(204);
  });
});

describe("company isolation", () => {
  it("never shows, edits or deletes another company's items", async () => {
    const owner = await ownerSession();
    const other = await ownerSession();
    const theirs = await create(other.token, service);

    expect((await list(owner.token)).body.total).toBe(0);
    expect((await api().get(`/api/products/${theirs.id}`).set(auth(owner.token))).status).toBe(404);
    expect((await api().patch(`/api/products/${theirs.id}`).set(auth(owner.token)).send({ price: "1" })).status).toBe(404);
    expect((await api().delete(`/api/products/${theirs.id}`).set(auth(owner.token))).status).toBe(404);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: theirs.id } })).price.toFixed(2)).toBe("25000.00");
  });
});

describe("GET /api/products (list)", () => {
  async function seed(token: string) {
    await create(token, service);
    await create(token, { ...service, name: "دعم فني شهري", code: "SRV-002", category: "support" });
    await create(token, product);
  }

  it("lists newest first, filters by type, category and search, with tab counts", async () => {
    const owner = await ownerSession();
    await seed(owner.token);

    expect(codes(await list(owner.token))).toEqual(["PRD-014", "SRV-002", "SRV-001"]);
    expect(codes(await list(owner.token, "?type=service"))).toEqual(["SRV-002", "SRV-001"]);
    expect(codes(await list(owner.token, "?category=network"))).toEqual(["PRD-014"]);
    expect(codes(await list(owner.token, "?q=wifi"))).toEqual(["PRD-014"]);
    expect(codes(await list(owner.token, "?q=srv-00"))).toEqual(["SRV-002", "SRV-001"]);

    const filtered = await list(owner.token, "?type=product");
    expect(filtered.body.counts).toEqual({ all: 3, service: 2, product: 1 });
    expect(filtered.body.total).toBe(1);
  });

  it("pages through the results", async () => {
    const owner = await ownerSession();
    for (let i = 1; i <= 9; i++) await create(owner.token, { ...service, code: `SRV-${i}` });
    const page2 = await list(owner.token, "?pageSize=7&page=2");
    expect(page2.body).toMatchObject({ total: 9, page: 2, pageSize: 7 });
    expect(page2.body.items).toHaveLength(2);
  });

  it("rejects bad query parameters", async () => {
    const owner = await ownerSession();
    for (const q of ["?type=thing", "?category=food", "?pageSize=500"]) {
      expect((await list(owner.token, q)).status).toBe(400);
    }
  });
});

describe("GET /api/products/next-code", () => {
  it("suggests the next free code per type", async () => {
    const owner = await ownerSession();
    const next = async (type: string) =>
      (await api().get(`/api/products/next-code?type=${type}`).set(auth(owner.token))).body.code;

    expect(await next("service")).toBe("SRV-001");
    await create(owner.token, service);
    await create(owner.token, { ...service, code: "SRV-014" });
    await create(owner.token, { ...service, code: "SRV-CUSTOM" });
    expect(await next("service")).toBe("SRV-015");
    expect(await next("product")).toBe("PRD-001");
    expect((await api().get("/api/products/next-code?type=x").set(auth(owner.token))).status).toBe(400);
  });
});

describe("PATCH /api/products/:id", () => {
  it("changes only what was sent", async () => {
    const owner = await ownerSession();
    const item = await create(owner.token, product);
    const res = await api().patch(`/api/products/${item.id}`).set(auth(owner.token)).send({ price: "2000", stock: 5 });
    expect(res.body.product).toMatchObject({ name: product.name, price: "2000.00", stock: 5, lowStockAt: 10 });
  });

  it("switching a product to a service clears its stock, and back gives 0", async () => {
    const owner = await ownerSession();
    const item = await create(owner.token, product);

    const toService = await api().patch(`/api/products/${item.id}`).set(auth(owner.token)).send({ type: "service" });
    expect(toService.body.product).toMatchObject({ type: "service", stock: null, lowStockAt: null });

    const back = await api().patch(`/api/products/${item.id}`).set(auth(owner.token)).send({ type: "product" });
    expect(back.body.product).toMatchObject({ type: "product", stock: 0, lowStockAt: 0 });
  });

  it("refuses a code another item uses", async () => {
    const owner = await ownerSession();
    await create(owner.token, service);
    const item = await create(owner.token, product);
    const res = await api().patch(`/api/products/${item.id}`).set(auth(owner.token)).send({ code: "srv-001" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CODE_TAKEN");
  });
});

describe("POST /api/products/import", () => {
  it("creates all rows", async () => {
    const owner = await ownerSession();
    const res = await api()
      .post("/api/products/import")
      .set(auth(owner.token))
      .send({ products: [service, product] });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
  });

  it("saves nothing if a row is invalid or reuses a code (in the file or the catalog)", async () => {
    const owner = await ownerSession();
    await create(owner.token, service);

    const res = await api()
      .post("/api/products/import")
      .set(auth(owner.token))
      .send({
        products: [
          product, // fine
          { ...service, code: "srv-001" }, // already in the catalog
          { ...product, name: "Copy" }, // same code as row 1
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMPORT_INVALID_ROWS");
    expect(res.body.error.details.rows.map((r: { row: number }) => r.row)).toEqual([2, 3]);
    expect(await prisma.product.count()).toBe(1);
  });
});
