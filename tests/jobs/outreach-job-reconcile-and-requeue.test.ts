// tests/jobs/outreach-job-reconcile-and-requeue.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { reconcileAndRequeueOutreachJobAsNotSent } from "../../src/jobs/outreach-reconciliation.js";
import {
  claimOutreachSend,
  markOutreachNeedsReconciliation,
} from "../../src/outreach/outreach-send.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach reconciliation requeue: atomically restores a confirmed-not-sent job", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  const job = await createOutreachJob(draftId);

  const claim = await claimOutreachSend(prospectId, draftId);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const reconciliation = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "TEST_UNCERTAIN_SEND",
  );

  if (!reconciliation.completed) {
    throw new Error(`Could not enter reconciliation: ${reconciliation.reason}`);
  }

  await db.query(
    `
      UPDATE outreach_jobs
      SET
        status = 'failed',
        attempt_count = 1,
        last_error = 'TEST_UNCERTAIN_SEND'
      WHERE id = $1;
    `,
    [job.id],
  );

  const result = await reconcileAndRequeueOutreachJobAsNotSent(job.id);

  assert.equal(result.reconciled, true);

  if (!result.reconciled) {
    throw new Error("Expected reconciliation to succeed");
  }

  assert.equal(result.job.status, "pending");
  assert.equal(result.job.attempt_count, 1);
  assert.equal(result.job.last_error, "TEST_UNCERTAIN_SEND");

  assert.equal(result.draft.send_status, "pending");
  assert.equal(result.draft.review_status, "approved");
  assert.equal(result.draft.send_error, null);
  assert.equal(result.draft.reconciliation_at, null);

  assert.equal(result.prospect.stage, "draft_ready");
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
