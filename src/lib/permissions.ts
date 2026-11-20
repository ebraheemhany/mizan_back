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
  // Adding, editing and completing tasks; every role can read them.
  tasks: ["owner", "accountant", "sales"],
  settings: ["owner"],
  deleteData: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission) {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
