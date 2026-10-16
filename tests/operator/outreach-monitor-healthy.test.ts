// tests/operator/outreach-monitor-healthy.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachMonitor } from "../../src/operator/outreach-monitor.js";
import type {
  GetOutreachOperationalStatusOptions,
  OutreachOperationalStatus,
} from "../../src/operator/outreach-operations.js";

const healthyStatus: OutreachOperationalStatus = {
  checkedAt: new Date("2026-10-16T12:00:00.000Z"),
  healthy: true,
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
    failedJobs: 0,
    staleProcessingJobs: 0,
    overdueReadyJobs: 0,
    draftsNeedingReconciliation: 0,
    prospectsNeedingReconciliation: 0,
  },
  oldestReadyPendingAt: null,
  oldestProcessingClaimedAt: null,
  alerts: [],
};

test("Outreach monitor: emits JSON and exits zero when healthy", async () => {
  let requestedOptions: GetOutreachOperationalStatusOptions | null = null;
  let outputLine = "";

  const exitCode = await runOutreachMonitor({
    env: {},
    getStatus: async (options) => {
      requestedOptions = options;
      return healthyStatus;
    },
    write: (line) => {
      outputLine = line;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requestedOptions, {
    staleProcessingMinutes: 15,
    readyPendingMinutes: 30,
  });
  assert.deepEqual(JSON.parse(outputLine), {
    service: "outreach-monitor",
    ...healthyStatus,
    checkedAt: "2026-10-16T12:00:00.000Z",
  });
});
