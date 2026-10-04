// src/outreach-job-retry-claim.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  retryOutreachJob,
} from "./outreach-jobs.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job retry claim: claims an eligible retry as a second attempt", async () => {
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

  const errorMessage = "Temporary provider failure";
  const retryAt = new Date(Date.now() - 1_000);

  const retriedJob = await retryOutreachJob(
    claimedJob.id,
    errorMessage,
    retryAt,
  );

  assert.equal(retriedJob.id, claimedJob.id);
  assert.equal(retriedJob.status, "pending");
  assert.equal(retriedJob.attempt_count, 1);
  assert.equal(retriedJob.last_error, errorMessage);
  assert.equal(retriedJob.claimed_at, null);

  const claimRetry = await claimNextOutreachJob();
  assert.ok(claimRetry);
  assert.equal(claimRetry.id, job.id);
  assert.equal(claimRetry.status, "processing");
  assert.equal(claimRetry.attempt_count, 2);
  assert.notEqual(claimRetry.claimed_at, null);
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
