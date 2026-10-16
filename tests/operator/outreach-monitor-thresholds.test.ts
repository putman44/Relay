// tests/operator/outreach-monitor-thresholds.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachMonitor } from "../../src/operator/outreach-monitor.js";
import type {
  GetOutreachOperationalStatusOptions,
  OutreachOperationalStatus,
} from "../../src/operator/outreach-operations.js";

test("Outreach monitor: passes configured thresholds to the status query", async () => {
  let requestedOptions: GetOutreachOperationalStatusOptions | null = null;
  const status: OutreachOperationalStatus = {
    checkedAt: new Date("2026-10-16T12:00:00.000Z"),
    healthy: true,
    thresholds: {
      staleProcessingMinutes: 17,
      readyPendingMinutes: 41,
    },
    counts: {
      pendingJobs: 0,
      readyPendingJobs: 0,
      delayedPendingJobs: 0,
      processingJobs: 0,
      completedJobs: 0,
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

  const exitCode = await runOutreachMonitor({
    env: {
      RELAY_STALE_PROCESSING_MINUTES: "17",
      RELAY_READY_PENDING_ALERT_MINUTES: "41",
    },
    getStatus: async (options) => {
      requestedOptions = options;
      return status;
    },
    write: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(requestedOptions, {
    staleProcessingMinutes: 17,
    readyPendingMinutes: 41,
  });
});
