import { z } from "zod";

export const ADMIN_PAGE_SIZE = 25;

export const listCompaniesQuerySchema = z.object({
  /** Company name, or the owner's name or email. */
  q: z.string().trim().max(100).optional(),
  /** The plan in force (free = no subscription, or an ended one). */
  plan: z.enum(["all", "free", "pro", "business"]).default("all"),
  sort: z.enum(["newest", "oldest", "active", "usage", "name"]).default("newest"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;
