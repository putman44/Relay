// tests/jobs/process-outreach-job-claim.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import type { GmailDraftSender } from "../../src/gmail/gmail-types.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job processing: claims the exact referenced draft", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    subject: "Processor target draft",
    gmailDraftId: "TEST_PROCESSOR_GMAIL_DRAFT",
  });

  const job = await createOutreachJob(draftId);

  let receivedGmailDraftId: string | null = null;

  const sendDraft: GmailDraftSender = async (gmailDraftId) => {
    receivedGmailDraftId = gmailDraftId;

    return {
      status: "sent",
      messageId: "TEST_PROCESSOR_MESSAGE",
      threadId: "TEST_PROCESSOR_THREAD",
    };
  };

  const result = await processOutreachJob(job, sendDraft);
  assert.equal(result.claim.draft.id, draftId);
  assert.equal(result.claim.draft.prospect_id, prospectId);
  assert.equal(result.claim.draft.send_status, "sending");

  assert.equal(receivedGmailDraftId, "TEST_PROCESSOR_GMAIL_DRAFT");
  assert.equal(result.gmailResult.status, "sent");
  assert.equal(result.finalization.draft.send_status, "sent");
  assert.equal(
    result.finalization.draft.sent_message_id,
    "TEST_PROCESSOR_MESSAGE",
  );
  assert.equal(
    result.finalization.draft.gmail_thread_id,
    "TEST_PROCESSOR_THREAD",
  );

  const draftStatusResult = await db.query<{ send_status: string }>(
    `
      SELECT send_status
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  assert.equal(draftStatusResult.rows[0]?.send_status, "sent");
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
