// tests/operator/outreach-monitor-attention.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachMonitor } from "../../src/operator/outreach-monitor.js";
import type { OutreachOperationalStatus } from "../../src/operator/outreach-operations.js";

test("Outreach monitor: exits two when attention is required", async () => {
  const status: OutreachOperationalStatus = {
    checkedAt: new Date("2026-10-16T12:00:00.000Z"),
    healthy: false,
    thresholds: {
      staleProcessingMinutes: 15,
      readyPendingMinutes: 30,
    },
    counts: {
      pendingJobs: 0,
      readyPendingJobs: 0,
      delayedPendingJobs: 0,
      processingJobs: 0,
      completedJobs: 1,
      failedJobs: 1,
      staleProcessingJobs: 0,
      overdueReadyJobs: 0,
      draftsNeedingReconciliation: 0,
      prospectsNeedingReconciliation: 0,
    },
    oldestReadyPendingAt: null,
    oldestProcessingClaimedAt: null,
    alerts: [{ code: "failed_jobs", count: 1 }],
  };
  let outputLine = "";

  const exitCode = await runOutreachMonitor({
    env: {},
    getStatus: async () => status,
    write: (line) => {
      outputLine = line;
    },
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(JSON.parse(outputLine).alerts, [
    { code: "failed_jobs", count: 1 },
  ]);
});
