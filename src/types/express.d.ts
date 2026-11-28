import type { Role } from "../generated/prisma/client.js";
import type { Permission } from "../lib/permissions.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        companyId: string;
        role: Role;
        /** What this user may do (their role's permissions, read on every request). */
        permissions: readonly Permission[];
      };
    }
  }
}

export {};
