import { logger } from "../../lib/logger.js";
import { reportError } from "../../lib/error-alerts.js";
import { runDueRecurring } from "./recurring.service.js";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15_000;

/**
 * Makes the recurring invoices that are due: shortly after the server starts, then
 * every hour (so a day's invoices appear soon after midnight, Cairo time). Runs never
 * overlap here, and a second server running it at the same time makes no duplicates
 * (one invoice per template and date).
 */
export function startRecurringJob() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDueRecurring();
      if (result.templates > 0) logger.info(result, "Recurring invoices run");
    } catch (err) {
      logger.error({ err }, "Recurring invoices run failed");
      void reportError(err, { where: "job: recurring invoices" });
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
