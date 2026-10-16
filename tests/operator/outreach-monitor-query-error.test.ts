// tests/operator/outreach-monitor-query-error.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachMonitor } from "../../src/operator/outreach-monitor.js";

test("Outreach monitor: propagates status-query failures to the CLI error boundary", async () => {
  let wroteOutput = false;

  await assert.rejects(
    runOutreachMonitor({
      env: {},
      getStatus: async () => {
        throw new Error("Database unavailable");
      },
      write: () => {
        wroteOutput = true;
      },
    }),
    { message: "Database unavailable" },
  );

  assert.equal(wroteOutput, false);
});
