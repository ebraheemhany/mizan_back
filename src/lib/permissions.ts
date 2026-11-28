import type { Role } from "../generated/prisma/client.js";

/**
 * What each built-in role may do. This is what the API enforces.
 * The frontend has the same table (lib/auth/permissions.ts) only to hide
 * buttons; keep the two in sync when changing either.
 * A custom role (role = "custom") has the permissions its owner picked instead
 * (CompanyRole.permissions), so it appears in none of these lists.
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
  // Employees, their pay, advances, attendance and files; preparing, approving and paying
  // the monthly payroll. Salaries are private: not for sales or viewers.
  payroll: ["owner", "accountant"],
  settings: ["owner"],
  deleteData: ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Every permission there is, in a fixed order (what a custom role picks from). */
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export const isPermission = (key: string): key is Permission => key in PERMISSIONS;

/**
 * What someone with this role may do: a built-in role's list, or for a custom role
 * the permissions its owner picked (unknown keys, e.g. from an older version, ignored).
 */
export function permissionsFor(role: Role, custom?: readonly string[] | null): Permission[] {
  if (role === "custom") return PERMISSION_KEYS.filter((key) => custom?.includes(key));
  return PERMISSION_KEYS.filter((key) => (PERMISSIONS[key] as readonly Role[]).includes(role));
}

/** Whether this user may do it (req.user, or an actor built from it). */
export function can(user: { permissions: readonly Permission[] }, permission: Permission) {
  return user.permissions.includes(permission);
}
