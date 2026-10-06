// tests/jobs/outreach-job-reconcile-and-requeue-rejects-nonfailed.test.ts
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

test("Outreach reconciliation requeue: rejects a job that is not failed", async () => {
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

  // Notice: we deliberately do NOT mark the job failed.
  // It is still pending.
  const result = await reconcileAndRequeueOutreachJobAsNotSent(job.id);

  assert.equal(result.reconciled, false);

  if (result.reconciled) {
    throw new Error("Expected reconciliation to be rejected");
  }

  assert.equal(
    result.reason,
    "Outreach job cannot be reconciled. Current status: pending",
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
