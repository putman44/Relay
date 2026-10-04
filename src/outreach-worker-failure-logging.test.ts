// src/outreach-worker-failure-logging.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import {
  claimNextOutreachJob,
  createOutreachJob,
  retryOutreachJob,
  type OutreachJob,
} from "./outreach-jobs.js";
import {
  runOutreachWorkerOnce,
  type OutreachWorkerEvent,
} from "./outreach-worker.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach worker logging: records a terminal failure after the final attempt", async () => {
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

  await retryOutreachJob(
    firstClaim.id,
    "First failure",
    new Date(Date.now() - 1_000),
  );

  const secondClaim = await claimNextOutreachJob();
  assert.ok(secondClaim);
  assert.equal(secondClaim.attempt_count, 2);

  await retryOutreachJob(
    secondClaim.id,
    "Second failure",
    new Date(Date.now() - 1_000),
  );

  const processJob = async (_job: OutreachJob): Promise<void> => {
    throw new Error("Third failure");
  };

  const events: OutreachWorkerEvent[] = [];

  const logger = (event: OutreachWorkerEvent): void => {
    events.push(event);
  };

  const result = await runOutreachWorkerOnce(processJob, logger);

  assert.ok(result);
  assert.equal(result.status, "failed");

  assert.equal(events.length, 2);

  assert.deepEqual(events[0], {
    type: "claimed",
    jobId: job.id,
    attemptCount: 3,
  });
  assert.deepEqual(events[1], {
    type: "failed",
    jobId: job.id,
    attemptCount: 3,
    error: "Third failure",
  });
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
