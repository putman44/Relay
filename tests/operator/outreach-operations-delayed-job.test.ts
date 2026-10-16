// tests/operator/outreach-operations-delayed-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach operations: does not alert on a delayed pending job", async (t) => {
  const now = new Date();
  const baseline = await getOutreachOperationalStatus({ now });
  const availableAt = new Date(now.getTime() + 60 * 60_000);
  const prospectId = await createTestProspect({
    companyName: "Operations Delayed Job Company",
    contactEmail: "operations-delayed-job@devbytaylor.com",
  });

  t.after(async () => {
    await db.query("DELETE FROM prospects WHERE id = $1;", [prospectId]);
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "operations-delayed-job@devbytaylor.com",
  });

  await db.query(
    `
      INSERT INTO outreach_jobs (draft_id, available_at)
      VALUES ($1, $2);
    `,
    [draftId, availableAt],
  );

  const status = await getOutreachOperationalStatus({ now });

  assert.equal(status.healthy, baseline.healthy);
  assert.equal(status.counts.pendingJobs, baseline.counts.pendingJobs + 1);
  assert.equal(
    status.counts.delayedPendingJobs,
    baseline.counts.delayedPendingJobs + 1,
  );
  assert.equal(
    status.counts.readyPendingJobs,
    baseline.counts.readyPendingJobs,
  );
  assert.deepEqual(status.alerts, baseline.alerts);
});
