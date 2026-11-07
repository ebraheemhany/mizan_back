import { execSync } from "node:child_process";

// Runs once before all tests: bring the test database up to the latest migration.
// DATABASE_URL already points at the test database (set in vitest.config.ts).
export default function setup() {
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });
}
