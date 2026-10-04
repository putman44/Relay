// src/outreach-worker-failure.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  retryOutreachJob,
  type OutreachJob,
} from "../../src/outreach-jobs.js";
import { runOutreachWorkerOnce } from "../../src/outreach-worker.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";
let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach worker failure: marks the third failed attempt terminally failed", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  const firstClaim = await claimNextOutreachJob();
  assert.ok(firstClaim);
  assert.equal(firstClaim.attempt_count, 1);

  const firstRetry = await retryOutreachJob(
    firstClaim.id,
    "First failure",
    new Date(Date.now() - 1_000),
  );

  assert.equal(firstRetry.status, "pending");

  const secondClaim = await claimNextOutreachJob();
  assert.ok(secondClaim);
  assert.equal(secondClaim.attempt_count, 2);

  const secondRetry = await retryOutreachJob(
    secondClaim.id,
    "Second failure",
    new Date(Date.now() - 1_000),
  );

  assert.equal(secondRetry.status, "pending");

  const processJob = async (_job: OutreachJob): Promise<void> => {
    throw new Error("Third failure");
  };

  const result = await runOutreachWorkerOnce(processJob);
  assert.ok(result);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.attempt_count, 3);
  assert.equal(result.last_error, "Third failure");
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
