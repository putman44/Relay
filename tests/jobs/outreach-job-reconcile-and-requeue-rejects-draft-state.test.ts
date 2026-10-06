// tests/jobs/outreach-job-reconcile-and-requeue-rejects-draft-state.test.ts
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

test("Outreach reconciliation requeue: rejects a draft that is not awaiting reconciliation", async () => {
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

  // Break only the draft portion of the reconciliation state.
  // The job is failed and the prospect remains send_reconciliation.
  await db.query(
    `
      UPDATE message_drafts
      SET send_status = 'pending'
      WHERE id = $1;
    `,
    [draftId],
  );

  const result = await reconcileAndRequeueOutreachJobAsNotSent(job.id);

  assert.equal(result.reconciled, false);

  if (result.reconciled) {
    throw new Error("Expected reconciliation to be rejected");
  }

  assert.equal(
    result.reason,
    "Outreach draft cannot be reconciled. Current send status: pending",
  );
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
