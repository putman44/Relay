// tests/operator/outreach-operations-failed-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach operations: alerts on a failed job", async (t) => {
  const baseline = await getOutreachOperationalStatus();
  const prospectId = await createTestProspect({
    companyName: "Operations Failed Job Company",
    contactEmail: "operations-failed-job@devbytaylor.com",
  });

  t.after(async () => {
    await db.query("DELETE FROM prospects WHERE id = $1;", [prospectId]);
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "operations-failed-job@devbytaylor.com",
  });

  await db.query(
    `
      INSERT INTO outreach_jobs (draft_id, status)
      VALUES ($1, 'failed');
    `,
    [draftId],
  );

  const status = await getOutreachOperationalStatus();
  const failedAlert = status.alerts.find(
    (alert) => alert.code === "failed_jobs",
  );

  assert.equal(status.healthy, false);
  assert.equal(status.counts.failedJobs, baseline.counts.failedJobs + 1);
  assert.deepEqual(failedAlert, {
    code: "failed_jobs",
    count: status.counts.failedJobs,
  });
});
