// src/outreach-job-failure.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  failOutreachJob,
} from "../../src/outreach-jobs.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job failure: marks a processing job failed", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  const claimedJob = await claimNextOutreachJob();
  assert.ok(claimedJob);
  assert.equal(claimedJob.status, "processing");

  const errorMessage = "Permanent provider failure";

  const failedJob = await failOutreachJob(claimedJob.id, errorMessage);
  assert.equal(failedJob.id, claimedJob.id);
  assert.equal(failedJob.status, "failed");
  assert.equal(failedJob.attempt_count, 1);
  assert.equal(failedJob.last_error, errorMessage);
  assert.notEqual(failedJob.claimed_at, null);
});
after(async () => {
  if (testProspectId) {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = $1;
      `,
      [testProspectId],
    );
  }

  if (testDraftId) {
    const remainingDraft = await db.query(
      `
        SELECT id
        FROM message_drafts
        WHERE id = $1;
      `,
      [testDraftId],
    );

    assert.equal(
      remainingDraft.rowCount,
      0,
      "Expected draft to be deleted by ON DELETE CASCADE",
    );
  }

  if (testJobId) {
    const remainingJob = await db.query(
      `
      SELECT id
      FROM outreach_jobs
      WHERE id = $1;
    `,
      [testJobId],
    );

    assert.equal(
      remainingJob.rowCount,
      0,
      "Expected outreach job to be deleted by ON DELETE CASCADE",
    );
  }

  await db.end();
});
