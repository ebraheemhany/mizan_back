import { logger } from "../../lib/logger.js";
import { reportError } from "../../lib/error-alerts.js";
import { runNotices } from "./notices.service.js";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * Sends the automatic emails that are due (reminders to customers, the team's morning
 * alerts, Saturday's digest): a minute after the server starts, then every hour. Runs
 * never overlap here, and each email is claimed before it goes, so another server
 * running this at the same time sends nothing twice.
 */
export function startNoticesJob() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runNotices();
      if (result.sent > 0) logger.info(result, "Notices run");
    } catch (err) {
      logger.error({ err }, "Notices run failed");
      void reportError(err, { where: "job: notices" });
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
