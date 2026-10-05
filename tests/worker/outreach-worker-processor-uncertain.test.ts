// tests/worker/outreach-worker-processor-uncertain.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import type { GmailDraftSender } from "../../src/gmail/gmail-types.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { runOutreachWorkerOnce } from "../../src/jobs/outreach-worker.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach worker integration: uncertain send fails without retry", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    gmailDraftId: "TEST_WORKER_UNCERTAIN_DRAFT",
  });

  const job = await createOutreachJob(draftId);

  const sendDraft: GmailDraftSender = async () => {
    return {
      status: "uncertain",
      error: "Simulated Gmail timeout",
    };
  };

  const result = await runOutreachWorkerOnce(async (claimedJob) => {
    await processOutreachJob(claimedJob, sendDraft);
  });

  assert.ok(result);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "failed");
  assert.equal(result.attempt_count, 1);
  assert.match(result.last_error ?? "", /Gmail send outcome uncertain/);

  const draftResult = await db.query<{
    send_status: string;
    send_error: string | null;
  }>(
    `
      SELECT
        send_status,
        send_error
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  const draft = draftResult.rows[0];

  assert.ok(draft);
  assert.equal(draft.send_status, "needs_reconciliation");
  assert.equal(draft.send_error, "Simulated Gmail timeout");
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
