// What the assistant may call: Mizan's own API, endpoint by endpoint, as the signed-in
// user (so every permission, plan limit, validation and audit entry still applies).
// The bodies and query strings are rendered from the same zod schemas the routes
// validate with, so this reference can't drift from what the API accepts.
// Left out on purpose: signing in, passwords, paying for the plan, Paymob keys,
// file uploads (they need the browser), public links and Mizan's admin pages.
import { z } from "zod";
import { listAuditQuerySchema } from "../audit/audit.schemas.js";
import { acceptClaimSchema, listClaimsQuerySchema, rejectClaimSchema, transferDetailsSchema } from "../collections/collections.schemas.js";
import {
  bulkAssignSchema,
  bulkDeleteSchema,
  createCustomerSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from "../customers/customers.schemas.js";
import { createDealSchema, loseDealSchema, moveDealSchema, touchDealSchema, updateDealSchema } from "../deals/deals.schemas.js";
import { createExpenseSchema, listExpensesQuerySchema, payExpenseSchema } from "../expenses/expenses.schemas.js";
import { createInvitationSchema } from "../invitations/invitations.schemas.js";
import { creditNoteSchema } from "../invoices/credit-notes.js";
import {
  bulkCancelSchema,
  createInvoiceSchema,
  emailInvoiceSchema,
  listInvoicesQuerySchema,
  recordPaymentSchema,
  reminderSchema,
} from "../invoices/invoices.schemas.js";
import {
  accountSchema,
  entrySchema,
  listEntriesQuerySchema,
  monthBodySchema,
  trialBalanceQuerySchema,
  updateAccountSchema,
} from "../ledger/ledger.schemas.js";
import { createPaymentSchema, listPaymentsQuerySchema } from "../payments/payments.schemas.js";
import {
  advanceSchema,
  attendanceQuerySchema,
  attendanceSchema,
  createEmployeeSchema,
  createRunSchema,
  endEmployeeSchema,
  listEmployeesQuerySchema,
  payRunSchema,
  payslipEmailSchema,
  updateEmployeeSchema,
  updateItemSchema,
} from "../payroll/payroll.schemas.js";
import { createProductSchema, listProductsQuerySchema, nextCodeQuerySchema, updateProductSchema } from "../products/products.schemas.js";
import { createQuoteSchema, emailQuoteSchema, listQuotesQuerySchema, updateQuoteSchema } from "../quotes/quotes.schemas.js";
import { listRecurringQuerySchema, recurringSchema } from "../recurring/recurring.schemas.js";
import { periodQuerySchema, statementQuerySchema } from "../reports/reports.schemas.js";
import { roleSchema, updateRoleSchema } from "../roles/roles.schemas.js";
import { updateSettingsSchema } from "../settings/settings.schemas.js";
import { createSupplierSchema, listSuppliersQuerySchema, updateSupplierSchema } from "../suppliers/suppliers.schemas.js";
import { createTaskSchema, updateTaskSchema } from "../tasks/tasks.schemas.js";
import { changeRoleSchema } from "../users/users.schemas.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type Endpoint = {
  method: HttpMethod;
  /** With :params, e.g. /api/invoices/:ref */
  path: string;
  /** What it does, for the model. */
  does: string;
  query?: z.ZodType;
  body?: z.ZodType;
};

type Section = { title: string; note: string; endpoints: Endpoint[] };

const SECTIONS: Section[] = [
  {
    title: "Overview",
    note: "Every role.",
    endpoints: [
      { method: "GET", path: "/api/dashboard", does: "The dashboard: this month's numbers, what needs attention, recent invoices." },
      { method: "GET", path: "/api/team-members", does: "Everyone in the company (id, name, role): to assign customers, deals or tasks to someone." },
      { method: "GET", path: "/api/billing", does: "The company's plan, its limits and what is used of them." },
    ],
  },
  {
    title: "Customers",
    note: "Every role reads; writing needs editCustomers; deleting needs deleteData.",
    endpoints: [
      { method: "GET", path: "/api/customers", does: "Search and list customers (with balance and status).", query: listCustomersQuerySchema },
      { method: "GET", path: "/api/customers/:id", does: "One customer, with totals." },
      { method: "POST", path: "/api/customers", does: "Add a customer.", body: createCustomerSchema },
      { method: "PATCH", path: "/api/customers/:id", does: "Edit a customer (only the fields sent; null clears one).", body: updateCustomerSchema },
      { method: "POST", path: "/api/customers/bulk-assign", does: "Make a team member responsible for customers (null: nobody).", body: bulkAssignSchema },
      { method: "DELETE", path: "/api/customers/:id", does: "Delete a customer." },
      { method: "POST", path: "/api/customers/bulk-delete", does: "Delete several customers.", body: bulkDeleteSchema },
    ],
  },
  {
    title: "Products and services (the catalog used on invoice lines)",
    note: "Every role reads; writing needs editProducts; deleting needs deleteData.",
    endpoints: [
      { method: "GET", path: "/api/products", does: "List products and services.", query: listProductsQuerySchema },
      { method: "GET", path: "/api/products/next-code", does: "The next free code for a new product or service.", query: nextCodeQuerySchema },
      { method: "GET", path: "/api/products/:id", does: "One product." },
      { method: "POST", path: "/api/products", does: "Add a product or service (get a code from next-code first).", body: createProductSchema },
      { method: "PATCH", path: "/api/products/:id", does: "Edit a product.", body: updateProductSchema },
      { method: "DELETE", path: "/api/products/:id", does: "Delete a product." },
    ],
  },
  {
    title: "Invoices",
    note:
      ":ref is the invoice number (1044) or its id. Every role reads; writing needs issueInvoices; payments and credit notes need recordPayments. " +
      "Amounts are VAT-exclusive unit prices; the company's VAT rate is added. Issued invoices can't be dated after today.",
    endpoints: [
      { method: "GET", path: "/api/invoices", does: "Search and list invoices.", query: listInvoicesQuerySchema },
      { method: "GET", path: "/api/invoices/stats", does: "Totals: outstanding, overdue, paid this month..." },
      { method: "GET", path: "/api/invoices/:ref", does: "One invoice with lines, payments, credit notes and history." },
      { method: "POST", path: "/api/invoices", does: "Make an invoice: a draft (send: false) or issued now (send: true).", body: createInvoiceSchema },
      { method: "POST", path: "/api/invoices/:ref/send", does: "Issue a draft invoice (it gets its number and enters the books)." },
      { method: "POST", path: "/api/invoices/:ref/cancel", does: "Cancel an invoice." },
      { method: "POST", path: "/api/invoices/bulk-cancel", does: "Cancel several invoices.", body: bulkCancelSchema },
      { method: "POST", path: "/api/invoices/:ref/payments", does: "Record a payment received on this invoice.", body: recordPaymentSchema },
      { method: "POST", path: "/api/invoices/:ref/credit-notes", does: "A credit note (return, discount after the fact) on an issued invoice.", body: creditNoteSchema },
      { method: "DELETE", path: "/api/invoices/:ref/credit-notes/:id", does: "Take back a credit note (deleteData)." },
      { method: "POST", path: "/api/invoices/:ref/email", does: "Email the issued invoice's link to the customer.", body: emailInvoiceSchema },
      {
        method: "POST",
        path: "/api/invoices/:ref/reminders",
        does: "Send a payment reminder by email (channel email). WhatsApp can't be sent from here: give the user the message to send instead.",
        body: reminderSchema,
      },
    ],
  },
  {
    title: "Payments received",
    note: "Every role reads; writing needs recordPayments.",
    endpoints: [
      { method: "GET", path: "/api/payments", does: "List payments received.", query: listPaymentsQuerySchema },
      { method: "GET", path: "/api/payments/stats", does: "Totals of payments received." },
      { method: "GET", path: "/api/payments/open-invoices", does: "Invoices that still have something to pay." },
      { method: "POST", path: "/api/payments", does: "Record a payment against an invoice (by the invoice's id).", body: createPaymentSchema },
      { method: "POST", path: "/api/payments/:id/clear", does: "A pending cheque was cashed." },
      { method: "POST", path: "/api/payments/:id/bounce", does: "A pending cheque bounced (the invoice is owed again)." },
      { method: "DELETE", path: "/api/payments/:id", does: "Remove a payment." },
      { method: "GET", path: "/api/payment-claims", does: "Transfer receipts customers sent from the invoice link, to review.", query: listClaimsQuerySchema },
      { method: "POST", path: "/api/payment-claims/:id/accept", does: "Accept a customer's transfer receipt (records the payment).", body: acceptClaimSchema },
      { method: "POST", path: "/api/payment-claims/:id/reject", does: "Reject a customer's transfer receipt.", body: rejectClaimSchema },
      { method: "GET", path: "/api/payment-setup", does: "How customers can pay invoices (transfer details, card payments on or off)." },
      { method: "PUT", path: "/api/payment-setup/transfer", does: "Set the transfer details shown to customers (owner).", body: transferDetailsSchema },
    ],
  },
  {
    title: "Quotes",
    note: ":ref is the quote number or id. Every role reads; writing needs quotes. To turn an accepted quote into an invoice, POST /api/invoices with fromQuote.",
    endpoints: [
      { method: "GET", path: "/api/quotes", does: "List quotes.", query: listQuotesQuerySchema },
      { method: "GET", path: "/api/quotes/stats", does: "Quote totals." },
      { method: "GET", path: "/api/quotes/:ref", does: "One quote." },
      { method: "POST", path: "/api/quotes", does: "Make a quote (draft, or send: true).", body: createQuoteSchema },
      { method: "PATCH", path: "/api/quotes/:ref", does: "Edit a draft quote (send every field again).", body: updateQuoteSchema },
      { method: "POST", path: "/api/quotes/:ref/send", does: "Send a draft quote." },
      { method: "POST", path: "/api/quotes/:ref/email", does: "Email a sent quote to the customer.", body: emailQuoteSchema },
      { method: "POST", path: "/api/quotes/:ref/accept", does: "Mark a quote accepted." },
      { method: "POST", path: "/api/quotes/:ref/reject", does: "Mark a quote rejected." },
      { method: "POST", path: "/api/quotes/:ref/duplicate", does: "Copy a quote into a new draft." },
      { method: "DELETE", path: "/api/quotes/:ref", does: "Delete a quote." },
    ],
  },
  {
    title: "Recurring invoices (paid plans)",
    note: "Every role reads; writing needs issueInvoices.",
    endpoints: [
      { method: "GET", path: "/api/recurring", does: "List recurring invoice templates.", query: listRecurringQuerySchema },
      { method: "GET", path: "/api/recurring/:id", does: "One template and the invoices it made." },
      { method: "POST", path: "/api/recurring", does: "Make a template.", body: recurringSchema },
      { method: "PATCH", path: "/api/recurring/:id", does: "Edit a template (send every field again).", body: recurringSchema },
      { method: "POST", path: "/api/recurring/:id/pause", does: "Pause a template." },
      { method: "POST", path: "/api/recurring/:id/resume", does: "Resume a template." },
      { method: "DELETE", path: "/api/recurring/:id", does: "Delete a template (its invoices stay)." },
    ],
  },
  {
    title: "Expenses and suppliers",
    note: "Needs the expenses permission; deleting a supplier needs deleteData. Expense amounts include VAT; vat is the VAT inside them.",
    endpoints: [
      { method: "GET", path: "/api/expenses", does: "List expenses.", query: listExpensesQuerySchema },
      { method: "GET", path: "/api/expenses/stats", does: "Expense totals." },
      { method: "GET", path: "/api/expenses/due", does: "Expenses not paid yet (what the company owes suppliers)." },
      { method: "POST", path: "/api/expenses", does: "Add an expense (paid, or due with a due date).", body: createExpenseSchema },
      { method: "POST", path: "/api/expenses/:id/pay", does: "Pay a due expense.", body: payExpenseSchema },
      { method: "DELETE", path: "/api/expenses/:id", does: "Delete an expense." },
      { method: "GET", path: "/api/suppliers", does: "List suppliers with what is owed to each.", query: listSuppliersQuerySchema },
      { method: "GET", path: "/api/suppliers/:id", does: "One supplier and their statement." },
      { method: "POST", path: "/api/suppliers", does: "Add a supplier.", body: createSupplierSchema },
      { method: "PATCH", path: "/api/suppliers/:id", does: "Edit a supplier.", body: updateSupplierSchema },
      { method: "DELETE", path: "/api/suppliers/:id", does: "Delete a supplier." },
    ],
  },
  {
    title: "Reports",
    note: "Needs reports. period: a month 'YYYY-MM' (not in the future), 'thisQuarter' or 'thisYear'; left out = this month.",
    endpoints: [
      { method: "GET", path: "/api/reports/summary", does: "Profit and loss summary: revenue, expenses, profit.", query: periodQuerySchema },
      { method: "GET", path: "/api/reports/aging", does: "What customers owe, by how late it is." },
      { method: "GET", path: "/api/reports/vat", does: "VAT report: output VAT on sales, input VAT on purchases, what is due.", query: periodQuerySchema },
      { method: "GET", path: "/api/reports/balance-sheet", does: "Balance sheet.", query: periodQuerySchema },
      { method: "GET", path: "/api/reports/cash-flow", does: "Cash flow.", query: periodQuerySchema },
      { method: "GET", path: "/api/reports/statement", does: "A customer's statement of account.", query: statementQuerySchema },
    ],
  },
  {
    title: "Tasks",
    note: "Every role reads; writing needs tasks.",
    endpoints: [
      { method: "GET", path: "/api/tasks", does: "Open tasks and those done in the last 60 days." },
      { method: "POST", path: "/api/tasks", does: "Add a task.", body: createTaskSchema },
      { method: "PATCH", path: "/api/tasks/:id", does: "Edit a task, or mark it done (done: true) / open again.", body: updateTaskSchema },
      { method: "DELETE", path: "/api/tasks/:id", does: "Delete a task." },
    ],
  },
  {
    title: "Deals (the sales pipeline)",
    note: "Every role reads; writing needs deals. A deal is won by moving it to stage won.",
    endpoints: [
      { method: "GET", path: "/api/deals", does: "The pipeline: open deals and those won or lost recently." },
      { method: "GET", path: "/api/deals/:id", does: "One deal." },
      { method: "POST", path: "/api/deals", does: "Add a deal.", body: createDealSchema },
      { method: "PATCH", path: "/api/deals/:id", does: "Edit a deal.", body: updateDealSchema },
      { method: "POST", path: "/api/deals/:id/move", does: "Move a deal to another stage (won included).", body: moveDealSchema },
      { method: "POST", path: "/api/deals/:id/lose", does: "Mark a deal lost.", body: loseDealSchema },
      { method: "POST", path: "/api/deals/:id/reopen", does: "Reopen a lost deal." },
      { method: "POST", path: "/api/deals/:id/touch", does: "Log a follow-up done now.", body: touchDealSchema },
      { method: "DELETE", path: "/api/deals/:id", does: "Delete a deal." },
    ],
  },
  {
    title: "Employees and payroll (paid plans)",
    note: "Needs payroll. :month is YYYY-MM.",
    endpoints: [
      { method: "GET", path: "/api/employees", does: "List employees.", query: listEmployeesQuerySchema },
      { method: "GET", path: "/api/employees/stats", does: "Headcount and payroll totals." },
      { method: "GET", path: "/api/employees/:id", does: "One employee: pay, advances, attendance of a year.", query: attendanceQuerySchema },
      { method: "POST", path: "/api/employees", does: "Add an employee.", body: createEmployeeSchema },
      { method: "PATCH", path: "/api/employees/:id", does: "Edit an employee.", body: updateEmployeeSchema },
      { method: "POST", path: "/api/employees/:id/end", does: "End an employee's service.", body: endEmployeeSchema },
      { method: "POST", path: "/api/employees/:id/reactivate", does: "Bring an ended employee back." },
      { method: "DELETE", path: "/api/employees/:id", does: "Delete an employee." },
      { method: "POST", path: "/api/employees/:id/advances", does: "Give an advance (repaid in monthly installments).", body: advanceSchema },
      { method: "DELETE", path: "/api/employees/:id/advances/:advanceId", does: "Remove an advance." },
      { method: "POST", path: "/api/employees/:id/attendance", does: "Record an absence or leave (within one month).", body: attendanceSchema },
      { method: "DELETE", path: "/api/employees/:id/attendance/:entryId", does: "Remove an attendance entry." },
      { method: "GET", path: "/api/payroll", does: "The payroll months." },
      { method: "POST", path: "/api/payroll", does: "Prepare a month's payroll (a draft).", body: createRunSchema },
      { method: "GET", path: "/api/payroll/:month", does: "A month's payroll with every employee's line." },
      { method: "POST", path: "/api/payroll/:month/refresh", does: "Recalculate a draft month from the employees' current data." },
      { method: "PATCH", path: "/api/payroll/:month/items/:itemId", does: "Change a line of a draft month (bonus, overtime, deductions).", body: updateItemSchema },
      { method: "DELETE", path: "/api/payroll/:month/items/:itemId", does: "Take an employee off a draft month." },
      { method: "POST", path: "/api/payroll/:month/approve", does: "Approve a month." },
      { method: "POST", path: "/api/payroll/:month/reopen", does: "Reopen an approved month." },
      { method: "POST", path: "/api/payroll/:month/pay", does: "Mark an approved month paid.", body: payRunSchema },
      { method: "POST", path: "/api/payroll/:month/unpay", does: "Undo paying a month." },
      { method: "DELETE", path: "/api/payroll/:month", does: "Delete a draft month." },
      { method: "GET", path: "/api/payroll/:month/items/:itemId/payslip", does: "An employee's payslip." },
      { method: "POST", path: "/api/payroll/:month/items/:itemId/email", does: "Email a payslip to the employee.", body: payslipEmailSchema },
    ],
  },
  {
    title: "The books (chart of accounts, journal, closing months)",
    note: "Needs ledger; reopening a closed month needs reopenPeriods. Invoices, payments, expenses and payroll make their entries automatically.",
    endpoints: [
      { method: "GET", path: "/api/ledger/accounts", does: "The chart of accounts with balances." },
      { method: "POST", path: "/api/ledger/accounts", does: "Add an account.", body: accountSchema },
      { method: "PATCH", path: "/api/ledger/accounts/:id", does: "Rename an added account.", body: updateAccountSchema },
      { method: "DELETE", path: "/api/ledger/accounts/:id", does: "Delete an added account." },
      { method: "GET", path: "/api/ledger/entries", does: "Journal entries (automatic and manual).", query: listEntriesQuerySchema },
      { method: "GET", path: "/api/ledger/entries/:id", does: "One manual entry." },
      { method: "POST", path: "/api/ledger/entries", does: "A manual journal entry (debits = credits).", body: entrySchema },
      { method: "PATCH", path: "/api/ledger/entries/:id", does: "Edit a manual entry.", body: entrySchema },
      { method: "POST", path: "/api/ledger/entries/:id/post", does: "Post a draft entry." },
      { method: "POST", path: "/api/ledger/entries/post-drafts", does: "Post every draft entry of a month.", body: monthBodySchema },
      { method: "DELETE", path: "/api/ledger/entries/:id", does: "Delete a manual entry." },
      { method: "GET", path: "/api/ledger/trial-balance", does: "Trial balance.", query: trialBalanceQuerySchema },
      { method: "GET", path: "/api/ledger/periods", does: "Which months are closed, and the closing checklist." },
      { method: "POST", path: "/api/ledger/periods/close", does: "Close a month (and every open month before it).", body: monthBodySchema },
      { method: "POST", path: "/api/ledger/periods/reopen", does: "Reopen the last closed month." },
    ],
  },
  {
    title: "Settings and team",
    note:
      "Reading settings: every role. Changing them, the team, roles and invitations: the owner. " +
      "PATCH /api/settings takes whole sections: read the settings first and send each section you change complete.",
    endpoints: [
      { method: "GET", path: "/api/settings", does: "Company details, taxes (VAT), numbering, invoice template, notifications." },
      { method: "PATCH", path: "/api/settings", does: "Change settings sections.", body: updateSettingsSchema },
      { method: "DELETE", path: "/api/settings/logo", does: "Remove the company logo." },
      { method: "GET", path: "/api/users", does: "Team members with emails and roles." },
      { method: "PATCH", path: "/api/users/:id", does: "Change a member's role.", body: changeRoleSchema },
      { method: "DELETE", path: "/api/users/:id", does: "Remove a member from the company." },
      { method: "GET", path: "/api/invitations", does: "Pending invitations." },
      { method: "POST", path: "/api/invitations", does: "Invite someone by email.", body: createInvitationSchema },
      { method: "DELETE", path: "/api/invitations/:id", does: "Cancel an invitation." },
      { method: "GET", path: "/api/roles", does: "The company's own roles." },
      { method: "POST", path: "/api/roles", does: "Make a role with a name and permissions.", body: roleSchema },
      { method: "PATCH", path: "/api/roles/:id", does: "Change a role.", body: updateRoleSchema },
      { method: "DELETE", path: "/api/roles/:id", does: "Delete a role nobody has." },
      { method: "GET", path: "/api/audit", does: "The audit log: who did what and when (owner).", query: listAuditQuerySchema },
    ],
  },
];

export const ENDPOINTS: Endpoint[] = SECTIONS.flatMap((section) => section.endpoints);

// ---------------------------------------------------------------------------
// Matching a call to an endpoint
// ---------------------------------------------------------------------------

/** A path segment the model may fill a :param with: ids, numbers, months, codes. */
const SEGMENT = "[A-Za-z0-9_-]{1,64}";

const patterns = ENDPOINTS.map((endpoint) => ({
  endpoint,
  regex: new RegExp(`^${endpoint.path.replace(/:[A-Za-z]+/g, SEGMENT)}$`),
}));

/**
 * The endpoint this call is for, or null when it isn't one the assistant may use.
 * Fixed paths (/api/invoices/stats) are listed before :params, and the first match wins.
 */
export function findEndpoint(method: string, path: string): Endpoint | null {
  if (!path.startsWith("/api/") || path.includes("..")) return null;
  return patterns.find((p) => p.endpoint.method === method && p.regex.test(path))?.endpoint ?? null;
}

// ---------------------------------------------------------------------------
// The reference the model reads (in the system prompt)
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

/** The money patterns: ^\d{1,12}(\.\d{1,2})?$ and the like. */
const isAmountPattern = (pattern: string) =>
  pattern.startsWith("^\\d{1,") && pattern.endsWith(")?$") && pattern.includes("(\\.\\d{1,");

function stringType(s: JsonSchema) {
  if (s.description === "yyyy-mm-dd") return "date";
  if (s.format === "uuid") return "uuid";
  if (s.format === "email") return "email";
  if (s.pattern && isAmountPattern(s.pattern)) return "amount";
  if (s.pattern?.includes("-(0[1-9]|1[0-2])")) return "YYYY-MM";
  if (s.pattern) return `string /${s.pattern}/`;
  return s.maxLength ? `string(max ${s.maxLength})` : "string";
}

function range(min?: number, max?: number) {
  const big = (n?: number) => n === undefined || Math.abs(n) > 1e12;
  if (big(min) && big(max)) return "";
  if (big(max)) return ` >=${min}`;
  if (big(min)) return ` <=${max}`;
  return ` ${min}..${max}`;
}

/** A schema as one short line of TypeScript-like text, e.g. { name: string, phone?: string | null }. */
function compact(s: JsonSchema): string {
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map(compact).join(" | ");
  if (s.allOf) return s.allOf.map(compact).join(" & ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "object": {
      const required = new Set(s.required ?? []);
      const fields = Object.entries(s.properties ?? {}).map(([key, value]) => {
        const optional = !required.has(key) || value.default !== undefined;
        const fallback = value.default !== undefined ? ` (default ${JSON.stringify(value.default)})` : "";
        return `${key}${optional ? "?" : ""}: ${compact(value)}${fallback}`;
      });
      return `{ ${fields.join(", ")} }`;
    }
    case "array": {
      const count = s.minItems !== undefined || s.maxItems !== undefined ? ` (${s.minItems ?? 0}-${s.maxItems ?? "any"} items)` : "";
      const item = s.items ? compact(s.items) : "any";
      return `${item.includes(" ") && !item.startsWith("{") ? `(${item})` : item}[]${count}`;
    }
    case "string":
      return stringType(s);
    case "integer":
      return `int${range(s.minimum, s.maximum)}`;
    case "number":
      return `number${range(s.minimum, s.maximum)}`;
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "any";
  }
}

const describe = (schema: z.ZodType) => compact(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema);

function renderEndpoint(endpoint: Endpoint) {
  const lines = [`${endpoint.method} ${endpoint.path} — ${endpoint.does}`];
  if (endpoint.query) lines.push(`  query ${describe(endpoint.query)}`);
  if (endpoint.body) lines.push(`  body ${describe(endpoint.body)}`);
  return lines.join("\n");
}

let reference: string | undefined;

/** Mizan's API as the model reads it (built once). */
export function apiReference() {
  reference ??= SECTIONS.map(
    (section) => `### ${section.title}\n(${section.note})\n${section.endpoints.map(renderEndpoint).join("\n")}`,
  ).join("\n\n");
  return reference;
}
