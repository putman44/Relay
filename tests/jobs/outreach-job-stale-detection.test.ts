// src/outreach-job-stale-detection.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  findStaleOutreachJobs,
} from "../../src/jobs/outreach-jobs.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job stale detection: finds a processing job claimed before the cutoff", async () => {
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

  const staleClaimedAt = new Date(Date.now() - 10 * 60_000);

  await db.query(
    `
    UPDATE outreach_jobs
    SET claimed_at = $2
    WHERE id = $1;
  `,
    [claimedJob.id, staleClaimedAt],
  );

  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const staleJobs = await findStaleOutreachJobs(staleBefore);
  assert.equal(staleJobs.length, 1);
  assert.equal(staleJobs[0]?.id, job.id);
  assert.equal(staleJobs[0]?.status, "processing");
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
