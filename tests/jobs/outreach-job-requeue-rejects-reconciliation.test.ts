import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import {
  createOutreachJob,
  requeueFailedOutreachJob,
} from "../../src/jobs/outreach-jobs.js";
import {
  claimOutreachSend,
  markOutreachNeedsReconciliation,
} from "../../src/outreach/outreach-send.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job requeue: rejects a draft still awaiting reconciliation", async () => {
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

  await assert.rejects(
    () => requeueFailedOutreachJob(job.id),
    /Outreach draft is not safe to requeue\. Current send status: needs_reconciliation/,
  );

  const jobResult = await db.query(
    `
      SELECT status, attempt_count, last_error
      FROM outreach_jobs
      WHERE id = $1;
    `,
    [job.id],
  );

  assert.equal(jobResult.rows[0]?.status, "failed");
  assert.equal(jobResult.rows[0]?.attempt_count, 1);
  assert.equal(jobResult.rows[0]?.last_error, "TEST_UNCERTAIN_SEND");
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
