import { z } from "zod";
import { Prisma, type ProductType } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { notFound } from "../../lib/params.js";
import { prisma } from "../../lib/prisma.js";
import { audit, changedFields } from "../audit/audit.service.js";
import { businessToday } from "../../lib/dates.js";
import { Decimal } from "../../lib/money.js";
import { moveStock, stockNumber } from "./stock.js";
import {
  createProductSchema,
  type CreateProductInput,
  type ListProductsQuery,
  type UpdateProductInput,
} from "./products.schemas.js";

const CODE_PREFIX: Record<ProductType, string> = { service: "SRV", product: "PRD" };

const productSelect = {
  id: true,
  name: true,
  type: true,
  code: true,
  price: true,
  taxRate: true,
  category: true,
  stock: true,
  lowStockAt: true,
  etaCodeType: true,
  etaCode: true,
  etaUnit: true,
  createdAt: true,
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

/** Money and percentages as 2-decimal strings ("1850.00", "14.00"). */
function toDto(row: ProductRow) {
  return {
    ...row,
    price: row.price.toFixed(2),
    taxRate: row.taxRate.toFixed(2),
    stock: stockNumber(row.stock),
    lowStockAt: stockNumber(row.lowStockAt),
    // How many invoices and quotes use it; counted once invoices exist.
    usageCount: 0,
  };
}

export type ProductDto = ReturnType<typeof toDto>;

const codeTaken = (code: string) =>
  new AppError(409, "CODE_TAKEN", `Another item already uses the code ${code}`, { field: "code" });

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Services have no stock; products start at 0 (the opening quantity is then added as a
 * logged movement). The alert level is 0 when not given.
 */
function stockFor(type: ProductType, lowStockAt: string | Prisma.Decimal | null | undefined) {
  return type === "service" ? { stock: null, lowStockAt: null } : { stock: 0, lowStockAt: lowStockAt ?? 0 };
}

/** The ETA code and unit as given (undefined = leave as is, null = clear). */
function etaFields(input: Pick<UpdateProductInput, "etaCodeType" | "etaCode" | "etaUnit">) {
  const out: { etaCodeType?: "GS1" | "EGS" | null; etaCode?: string | null; etaUnit?: string | null } = {};
  if (input.etaCodeType !== undefined) out.etaCodeType = input.etaCodeType;
  if (input.etaCode !== undefined) out.etaCode = input.etaCode;
  if (input.etaUnit !== undefined) out.etaUnit = input.etaUnit;
  return out;
}

/** Products at or under their alert level (where the alert level is above zero, or none is left). */
const lowWhere = (companyId: string): Prisma.ProductWhereInput => ({
  companyId,
  type: "product",
  stock: { lte: prisma.product.fields.lowStockAt },
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listProducts(companyId: string, query: ListProductsQuery) {
  const and: Prisma.ProductWhereInput[] = [{ companyId }];
  if (query.type !== "all") and.push({ type: query.type });
  if (query.category !== "all") and.push({ category: query.category });
  if (query.stock === "low") and.push(lowWhere(companyId));
  if (query.q) {
    const contains = { contains: query.q, mode: "insensitive" } as const;
    and.push({ OR: [{ name: contains }, { code: contains }] });
  }
  const where = { AND: and } satisfies Prisma.ProductWhereInput;

  const [rows, total, all, service, product, low] = await prisma.$transaction([
    prisma.product.findMany({
      where,
      select: productSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.product.count({ where }),
    // Tab counts: the whole catalog, regardless of the other filters.
    prisma.product.count({ where: { companyId } }),
    prisma.product.count({ where: { companyId, type: "service" } }),
    prisma.product.count({ where: { companyId, type: "product" } }),
    prisma.product.count({ where: lowWhere(companyId) }),
  ]);

  return {
    items: rows.map(toDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts: { all, service, product, low },
  };
}

export async function getProduct(companyId: string, id: string) {
  const row = await prisma.product.findFirst({ where: { id, companyId }, select: productSelect });
  if (!row) throw notFound("Product");
  return toDto(row);
}

/** The next free code for a type: SRV-015 after SRV-014, PRD-001 when there are none. */
export async function nextCode(companyId: string, type: ProductType) {
  const prefix = `${CODE_PREFIX[type]}-`;
  const rows = await prisma.product.findMany({
    where: { companyId, code: { startsWith: prefix } },
    select: { code: true },
  });
  const max = rows.reduce((m, { code }) => {
    const n = Number(code.slice(prefix.length));
    return Number.isInteger(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function createProduct(companyId: string, input: CreateProductInput, userId: string | null = null) {
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: input.name,
          type: input.type,
          code: input.code,
          price: input.price,
          taxRate: input.taxRate,
          category: input.category,
          ...stockFor(input.type, input.lowStockAt),
          ...etaFields(input),
          companyId,
        },
        select: { id: true },
      });
      // What's on hand when it's added opens its stock log.
      if (input.type === "product" && input.stock !== undefined) {
        await moveStock(tx, companyId, [{ productId: created.id, quantity: input.stock }], 1, {
          kind: "opening",
          date: businessToday(),
          userId,
        });
      }
      const row = await tx.product.findUniqueOrThrow({ where: { id: created.id }, select: productSelect });
      await audit(tx, companyId, {
        action: "create",
        event: "productCreated",
        item: { type: "product", id: row.id, ref: row.name },
        values: { code: row.code, price: String(row.price) },
      });
      return row;
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw codeTaken(input.code);
    throw err;
  }
}

export async function updateProduct(companyId: string, id: string, input: UpdateProductInput, userId: string | null = null) {
  const existing = await prisma.product.findFirst({
    where: { id, companyId },
    select: { type: true, stock: true, lowStockAt: true, name: true, code: true, price: true, taxRate: true, category: true },
  });
  if (!existing) throw notFound("Product");

  const type = input.type ?? existing.type;
  const data: Prisma.ProductUpdateInput = { type };
  if (type === "service") {
    data.stock = null;
    data.lowStockAt = null;
  } else {
    // Becoming a product starts its stock at 0; the stock itself only moves through movements.
    if (existing.type === "service") data.stock = 0;
    data.lowStockAt = input.lowStockAt ?? existing.lowStockAt ?? 0;
  }
  if (input.name !== undefined) data.name = input.name;
  if (input.code !== undefined) data.code = input.code;
  if (input.price !== undefined) data.price = input.price;
  if (input.taxRate !== undefined) data.taxRate = input.taxRate;
  if (input.category !== undefined) data.category = input.category;
  Object.assign(data, etaFields(input));

  try {
    const row = await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data, select: { id: true } });
      // A new stock figure typed in the form: the difference is logged (as a count, or as the
      // opening quantity of what just became a product).
      if (type === "product" && input.stock !== undefined) {
        const current = existing.type === "service" ? new Decimal(0) : new Decimal(existing.stock ?? 0);
        const delta = new Decimal(input.stock).minus(current);
        if (!delta.isZero()) {
          await moveStock(tx, companyId, [{ productId: id, quantity: delta }], 1, {
            kind: existing.type === "service" ? "opening" : "counted",
            date: businessToday(),
            userId,
          });
        }
      }
      const updated = await tx.product.findUniqueOrThrow({ where: { id }, select: productSelect });
      const fields = changedFields(existing as Record<string, unknown>, input as Record<string, unknown>);
      if (fields.length > 0) {
        await audit(tx, companyId, {
          action: "update",
          event: "productUpdated",
          item: { type: "product", id, ref: updated.name },
          values: { fields },
        });
      }
      return updated;
    });
    return toDto(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw codeTaken(input.code ?? "");
    throw err;
  }
}

export async function deleteProduct(companyId: string, id: string) {
  // When invoices exist, deleting an item used on an invoice will be refused.
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({ where: { id, companyId }, select: { name: true, code: true } });
    const { count } = await tx.product.deleteMany({ where: { id, companyId } });
    if (count === 0 || !product) throw notFound("Product");
    await audit(tx, companyId, {
      action: "delete",
      event: "productDeleted",
      item: { type: "product", ref: product.name },
      values: { code: product.code },
    });
  });
}

/**
 * Creates many items at once (CSV import). All or nothing: if any row is invalid
 * or reuses a code (from the file or already in the catalog), nothing is saved
 * and the error lists every bad row by number.
 */
export async function importProducts(companyId: string, rows: unknown[], userId: string | null = null) {
  const valid: CreateProductInput[] = [];
  const rowErrors: { row: number; fieldErrors: Record<string, string[] | undefined> }[] = [];

  rows.forEach((raw, index) => {
    const result = createProductSchema.safeParse(raw);
    if (result.success) valid.push(result.data);
    else rowErrors.push({ row: index + 1, fieldErrors: z.flattenError(result.error).fieldErrors });
  });

  if (rowErrors.length === 0) {
    const existing = new Set(
      (
        await prisma.product.findMany({
          where: { companyId, code: { in: valid.map((p) => p.code) } },
          select: { code: true },
        })
      ).map((p) => p.code),
    );
    const seen = new Set<string>();
    valid.forEach((p, index) => {
      if (existing.has(p.code) || seen.has(p.code)) {
        rowErrors.push({ row: index + 1, fieldErrors: { code: ["This code is already used"] } });
      }
      seen.add(p.code);
    });
  }

  if (rowErrors.length > 0) {
    throw new AppError(400, "IMPORT_INVALID_ROWS", "Some rows are invalid; nothing was imported", {
      rows: rowErrors.slice(0, 50),
      invalidCount: rowErrors.length,
    });
  }

  try {
    const { count } = await prisma.$transaction(async (tx) => {
      const rows = await tx.product.createManyAndReturn({
        data: valid.map((p) => ({
          name: p.name,
          type: p.type,
          code: p.code,
          price: p.price,
          taxRate: p.taxRate,
          category: p.category,
          ...stockFor(p.type, p.lowStockAt),
          ...etaFields(p),
          companyId,
        })),
        select: { id: true, code: true },
      });
      // Each product's quantity in the file opens its stock log.
      const stockByCode = new Map(valid.map((p) => [p.code, p.type === "product" ? p.stock : undefined]));
      const date = businessToday();
      for (const row of rows) {
        const quantity = stockByCode.get(row.code);
        if (quantity === undefined) continue;
        await moveStock(tx, companyId, [{ productId: row.id, quantity }], 1, { kind: "opening", date, userId });
      }
      const created = { count: rows.length };
      await audit(tx, companyId, {
        action: "create",
        event: "productsImported",
        item: { type: "product" },
        values: { count: created.count },
      });
      return created;
    });
    return { created: count };
  } catch (err) {
    // Someone added the same code at the same moment.
    if (isUniqueViolation(err)) throw codeTaken("");
    throw err;
  }
}
