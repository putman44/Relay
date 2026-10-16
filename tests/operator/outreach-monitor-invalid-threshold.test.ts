// tests/operator/outreach-monitor-invalid-threshold.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachMonitor } from "../../src/operator/outreach-monitor.js";

test("Outreach monitor: rejects invalid threshold configuration before querying", async () => {
  let queried = false;

  await assert.rejects(
    runOutreachMonitor({
      env: {
        RELAY_STALE_PROCESSING_MINUTES: "0",
      },
      getStatus: async () => {
        queried = true;
        throw new Error("Status query should not run");
      },
      write: () => undefined,
    }),
    { message: "RELAY_STALE_PROCESSING_MINUTES must be a positive integer" },
  );

  assert.equal(queried, false);
});
