// src/outreach-worker-logging.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  createOutreachJob,
  type OutreachJob,
} from "../../src/jobs/outreach-jobs.js";
import {
  runOutreachWorkerOnce,
  type OutreachWorkerEvent,
} from "../../src/jobs/outreach-worker.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";
let testProspectId: string | null = null;
let testDraftId: string | null = null;
let testJobId: string | null = null;

test("Outreach worker logging: records claim and completion events", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  const processJob = async (_job: OutreachJob): Promise<void> => {};

  const events: OutreachWorkerEvent[] = [];

  const logger = (event: OutreachWorkerEvent): void => {
    events.push(event);
  };

  const result = await runOutreachWorkerOnce(processJob, logger);

  assert.ok(result);
  assert.equal(result.status, "completed");

  assert.equal(events.length, 2);

  assert.deepEqual(events[0], {
    type: "claimed",
    jobId: job.id,
    attemptCount: 1,
  });

  assert.deepEqual(events[1], {
    type: "completed",
    jobId: job.id,
    attemptCount: 1,
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
