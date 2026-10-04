// src/outreach-job-completion-guard.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  completeOutreachJob,
  createOutreachJob,
} from "../../src/outreach-jobs.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach job completion guard: rejects completion when the job is still pending", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;
  assert.equal(job.status, "pending");

  await assert.rejects(
    () => completeOutreachJob(job.id),
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

  assert.equal(persistedJob.rows[0]?.status, "pending");
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
