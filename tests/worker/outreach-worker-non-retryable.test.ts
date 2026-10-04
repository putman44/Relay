// tests/worker/outreach-worker-non-retryable.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import {
  createOutreachJob,
  type OutreachJob,
} from "../../src/jobs/outreach-jobs.js";
import { runOutreachWorkerOnce } from "../../src/jobs/outreach-worker.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach worker non-retryable failure: fails on the first attempt", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  const processJob = async (_job: OutreachJob): Promise<void> => {
    throw new NonRetryableOutreachJobError("Ambiguous external send");
  };

  const result = await runOutreachWorkerOnce(processJob);

  assert.ok(result);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.attempt_count, 1);
  assert.equal(result.last_error, "Ambiguous external send");
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
