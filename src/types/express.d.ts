import type { Role } from "../generated/prisma/client.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        companyId: string;
        role: Role;
      };
    }
  }
}

export {};
