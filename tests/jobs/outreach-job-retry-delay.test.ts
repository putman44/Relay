// src/outreach-job-retry-delay.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  retryOutreachJob,
} from "../../src/outreach-jobs.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job retry delay: does not claim a retry before it is available", async () => {
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

  const retryAt = new Date(Date.now() + 60_000);

  const retriedJob = await retryOutreachJob(
    claimedJob.id,
    "Temporary provider failure",
    retryAt,
  );

  assert.equal(retriedJob.status, "pending");

  const nextJob = await claimNextOutreachJob();

  assert.equal(nextJob, null);
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
