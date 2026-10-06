// tests/jobs/outreach-job-reconcile-and-requeue-missing-job.test.ts
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { reconcileAndRequeueOutreachJobAsNotSent } from "../../src/jobs/outreach-reconciliation.js";

test("Outreach reconciliation requeue: rejects a missing job", async () => {
  const result = await reconcileAndRequeueOutreachJobAsNotSent(randomUUID());

  assert.deepEqual(result, {
    reconciled: false,
    reason: "Outreach job not found",
  });
});

after(async () => {
  await db.end();
});
