// src/outreach-worker-retry.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { createOutreachJob, type OutreachJob } from "./outreach-jobs.js";
import { runOutreachWorkerOnce } from "./outreach-worker.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach worker retry: schedules a failed first attempt for retry", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  const processJob = async (_job: OutreachJob): Promise<void> => {
    throw new Error("Temporary processing failure");
  };

  const result = await runOutreachWorkerOnce(processJob);
  assert.ok(result);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "pending");
  assert.equal(result.attempt_count, 1);
  assert.equal(result.last_error, "Temporary processing failure");
  assert.equal(result.claimed_at, null);
  assert.ok(result.available_at.getTime() > Date.now());
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
