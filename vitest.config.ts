import "dotenv/config";
import { defineConfig } from "vitest/config";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];

// The tests wipe every table, so refuse to run against anything that is not
// clearly a test database (protects the dev database in DATABASE_URL).
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
}
const dbName = new URL(testDatabaseUrl).pathname.slice(1);
if (!dbName.endsWith("_test")) {
  throw new Error(`TEST_DATABASE_URL must point at a database ending in "_test", got "${dbName}"`);
}

// globalSetup (which runs the migrations) uses this process's env, not test.env below.
process.env["DATABASE_URL"] = testDatabaseUrl;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // All test files share one database, so run them one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: testDatabaseUrl,
    },
  },
});
