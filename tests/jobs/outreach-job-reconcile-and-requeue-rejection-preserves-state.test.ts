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

type RecoveryState = {
  job_status: string;
  attempt_count: number;
  last_error: string | null;
  review_status: string;
  send_status: string;
  send_error: string | null;
  reconciliation_at: Date | null;
  prospect_stage: string;
};

test("Outreach reconciliation requeue: rejected recovery preserves all state", async () => {
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

  // Make the recovery invalid.
  await db.query(
    `
      UPDATE message_drafts
      SET review_status = 'rejected'
      WHERE id = $1;
    `,
    [draftId],
  );

  const readState = async (): Promise<RecoveryState> => {
    const result = await db.query<RecoveryState>(
      `
        SELECT
          j.status AS job_status,
          j.attempt_count,
          j.last_error,
          d.review_status,
          d.send_status,
          d.send_error,
          d.reconciliation_at,
          p.stage AS prospect_stage
        FROM outreach_jobs j
        JOIN message_drafts d
          ON d.id = j.draft_id
        JOIN prospects p
          ON p.id = d.prospect_id
        WHERE j.id = $1;
      `,
      [job.id],
    );

    const state = result.rows[0];

    if (!state) {
      throw new Error("Expected recovery state to exist");
    }

    return state;
  };

  const before = await readState();

  const result = await reconcileAndRequeueOutreachJobAsNotSent(job.id);

  assert.equal(result.reconciled, false);

  const afterState = await readState();

  assert.deepEqual(afterState, before);
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
