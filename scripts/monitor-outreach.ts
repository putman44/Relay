// scripts/monitor-outreach.ts
import "dotenv/config";

import { db } from "../src/db.js";
import { runOutreachMonitor } from "../src/operator/outreach-monitor.js";

const main = async (): Promise<void> => {
  process.exitCode = await runOutreachMonitor();
};

main()
  .catch((error) => {
    console.error(
      JSON.stringify({
        service: "outreach-monitor",
        status: "monitor_error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
