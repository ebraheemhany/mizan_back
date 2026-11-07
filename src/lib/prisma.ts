import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { config } from "../config.js";

const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  // The pg adapter sends dates without a time zone, so Postgres would read them
  // in the server's local zone (e.g. Africa/Cairo) and store them hours off.
  // Running every session in UTC keeps stored times correct on any server.
  options: "-c TimeZone=UTC",
});

export const prisma = new PrismaClient({ adapter });
