// tests/operator/outreach-operations-stale-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach operations: alerts on a stale processing job", async (t) => {
  const now = new Date();
  const baseline = await getOutreachOperationalStatus({ now });
  const claimedAt = new Date(now.getTime() - 60 * 60_000);
  const prospectId = await createTestProspect({
    companyName: "Operations Stale Job Company",
    contactEmail: "operations-stale-job@devbytaylor.com",
  });

  t.after(async () => {
    await db.query("DELETE FROM prospects WHERE id = $1;", [prospectId]);
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "operations-stale-job@devbytaylor.com",
  });

  await db.query(
    `
      INSERT INTO outreach_jobs (draft_id, status, claimed_at)
      VALUES ($1, 'processing', $2);
    `,
    [draftId, claimedAt],
  );

  const status = await getOutreachOperationalStatus({
    now,
    staleProcessingMinutes: 15,
  });
  const staleAlert = status.alerts.find(
    (alert) => alert.code === "stale_processing_jobs",
  );

  assert.equal(status.healthy, false);
  assert.equal(
    status.counts.processingJobs,
    baseline.counts.processingJobs + 1,
  );
  assert.equal(
    status.counts.staleProcessingJobs,
    baseline.counts.staleProcessingJobs + 1,
  );
  assert.deepEqual(staleAlert, {
    code: "stale_processing_jobs",
    count: status.counts.staleProcessingJobs,
  });
});
