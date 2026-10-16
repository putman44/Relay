// tests/operator/outreach-operations-status.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";

test("Outreach operations: returns a consistent operational snapshot", async () => {
  const status = await getOutreachOperationalStatus();

  assert.equal(status.healthy, status.alerts.length === 0);
  assert.ok(status.checkedAt instanceof Date);
  assert.ok(status.counts.pendingJobs >= 0);
  assert.ok(status.counts.processingJobs >= 0);
  assert.ok(status.counts.failedJobs >= 0);
  assert.ok(status.counts.draftsNeedingReconciliation >= 0);
  assert.ok(status.counts.prospectsNeedingReconciliation >= 0);
});
