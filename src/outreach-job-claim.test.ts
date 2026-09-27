// src/outreach-job-claim.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimNextOutreachJob, createOutreachJob } from "./outreach-jobs.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job claim: claims the next pending outreach job", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  assert.equal(job.draft_id, draftId);
  assert.equal(job.status, "pending");
  assert.equal(job.attempt_count, 0);
  assert.equal(job.claimed_at, null);
  assert.equal(job.last_error, null);

  const claimedJob = await claimNextOutreachJob();

  assert.ok(claimedJob);
  assert.equal(claimedJob.id, job.id);
  assert.equal(claimedJob.status, "processing");
  assert.equal(claimedJob.attempt_count, 1);
  assert.notEqual(claimedJob.claimed_at, null);
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
