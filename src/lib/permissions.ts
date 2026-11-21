import type { Role } from "../generated/prisma/client.js";

/**
 * What each role may do. This is what the API enforces.
 * The frontend has the same table (lib/auth/permissions.ts) only to hide
 * buttons; keep the two in sync when changing either.
 */
const PERMISSIONS = {
  viewCustomers: ["owner", "accountant", "sales", "viewer"],
  editCustomers: ["owner", "sales"],
  // Prices and tax rates are accounting data.
  editProducts: ["owner", "accountant"],
  issueInvoices: ["owner", "accountant"],
  recordPayments: ["owner", "accountant"],
  expenses: ["owner", "accountant"],
  reports: ["owner", "accountant"],
  // The books: chart of accounts, journal, trial balance, manual entries, closing months.
  ledger: ["owner", "accountant"],
  // Opening a closed month again changes what was final: the owner only.
  reopenPeriods: ["owner"],
  // The audit log shows everyone's actions, sign-ins and IPs.
  auditLog: ["owner"],
  // Adding, editing and completing tasks; every role can read them.
  tasks: ["owner", "accountant", "sales"],
  // Writing quotes (create, edit, send, accept/reject, duplicate, delete a draft);
  // every role can read them. Converting one needs issueInvoices (it makes an invoice).
  quotes: ["owner", "accountant", "sales"],
  // Working on the sales pipeline (add, edit, move, lose, reopen, delete); every role
  // can see it. Deleting a won deal needs deleteData.
  deals: ["owner", "accountant", "sales"],
  settings: ["owner"],
  deleteData: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission) {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
