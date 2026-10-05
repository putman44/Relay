import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import {
  createOutreachJob,
  requeueFailedOutreachJob,
} from "../../src/jobs/outreach-jobs.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job requeue: safely requeues a failed send-ready job", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  const job = await createOutreachJob(draftId);

  await db.query(
    `
      UPDATE outreach_jobs
      SET
        status = 'failed',
        attempt_count = 1,
        last_error = 'TEST_PREVIOUS_FAILURE'
      WHERE id = $1;
    `,
    [job.id],
  );

  const requeued = await requeueFailedOutreachJob(job.id);

  assert.equal(requeued.status, "pending");
  assert.equal(requeued.attempt_count, 1);
  assert.equal(requeued.last_error, "TEST_PREVIOUS_FAILURE");
  assert.equal(requeued.claimed_at, null);
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

  await db.end();
});
