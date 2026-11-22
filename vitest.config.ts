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
      // Never the real services, whatever .env holds: email stays in memory, payments use the test gateway.
      RESEND_API_KEY: "",
      GMAIL_SENDER: "",
      GMAIL_CLIENT_ID: "",
      GMAIL_CLIENT_SECRET: "",
      GMAIL_REFRESH_TOKEN: "",
      PAYMOB_SECRET_KEY: "",
      PAYMOB_PUBLIC_KEY: "",
      PAYMOB_CARD_INTEGRATION_ID: "",
      PAYMOB_MOTO_INTEGRATION_ID: "",
      // Signs the Paymob callbacks the tests send.
      PAYMOB_HMAC_SECRET: "test-hmac-secret",
      DATABASE_URL: testDatabaseUrl,
    },
  },
});
