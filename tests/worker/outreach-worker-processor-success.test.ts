// tests/worker/outreach-worker-processor-success.test.ts

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

test("Outreach worker integration: completes a job after a confirmed send", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    gmailDraftId: "TEST_WORKER_PROCESSOR_DRAFT",
  });

  const job = await createOutreachJob(draftId);

  const sendDraft: GmailDraftSender = async () => {
    return {
      status: "sent",
      messageId: "TEST_WORKER_MESSAGE",
      threadId: "TEST_WORKER_THREAD",
    };
  };

  const result = await runOutreachWorkerOnce(async (claimedJob) => {
    await processOutreachJob(claimedJob, sendDraft);
  });

  assert.ok(result);
  assert.equal(result.id, job.id);
  assert.equal(result.status, "completed");
  assert.equal(result.attempt_count, 1);

  const draftResult = await db.query<{
    send_status: string;
    sent_message_id: string | null;
  }>(
    `
      SELECT
        send_status,
        sent_message_id
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  const draft = draftResult.rows[0];

  assert.ok(draft);
  assert.equal(draft.send_status, "sent");
  assert.equal(draft.sent_message_id, "TEST_WORKER_MESSAGE");
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
