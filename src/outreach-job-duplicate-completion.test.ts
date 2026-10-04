// src/outreach-job-duplicate-completion.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import {
  claimNextOutreachJob,
  completeOutreachJob,
  createOutreachJob,
} from "./outreach-jobs.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job duplicate completion: rejects completion when the job is already completed", async () => {
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

  const completedJob = await completeOutreachJob(claimedJob.id);
  assert.equal(completedJob.status, "completed");

  await assert.rejects(
    () => completeOutreachJob(completedJob.id),
    /Outreach job is not processing/,
  );

  const persistedJob = await db.query<{ status: string }>(
    `
    SELECT status
    FROM outreach_jobs
    WHERE id = $1;
  `,
    [job.id],
  );

  assert.equal(persistedJob.rows[0]?.status, "completed");
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
