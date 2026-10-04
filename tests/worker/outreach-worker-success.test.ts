// src/outreach-worker-success.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  createOutreachJob,
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

test("Outreach worker success: processes and completes the next job", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const job = await createOutreachJob(draftId);
  testJobId = job.id;

  let processedJobId: string | null = null;

  const processJob = async (job: OutreachJob): Promise<void> => {
    processedJobId = job.id;
  };

  const result = await runOutreachWorkerOnce(processJob);
  assert.ok(result);
  assert.equal(processedJobId, job.id);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "completed");
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
