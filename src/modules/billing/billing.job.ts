import { logger } from "../../lib/logger.js";
import { runBilling } from "./billing.service.js";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30_000;

/**
 * Renews the subscriptions that are due (charging the saved card), retries the
 * ones that failed and ends the ones past their grace days: shortly after the
 * server starts, then every hour. Runs never overlap here; a second server running
 * it at the same time waits on the same subscription row and charges nothing twice.
 */
export function startBillingJob() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runBilling();
      if (result.checked > 0 || result.expired > 0) logger.info(result, "Subscriptions run");
    } catch (err) {
      logger.error({ err }, "Subscriptions run failed");
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const every = setInterval(run, HOUR_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
