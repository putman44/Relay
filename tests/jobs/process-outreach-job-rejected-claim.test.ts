// tests/jobs/process-outreach-job-rejected-claim.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import type { GmailDraftSender } from "../../src/gmail/gmail-types.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job processing: rejected claim is non-retryable", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    reviewStatus: "needs_review",
  });

  const job = await createOutreachJob(draftId);

  let sendCalled = false;

  const sendDraft: GmailDraftSender = async () => {
    sendCalled = true;

    return {
      status: "sent",
      messageId: "SHOULD_NOT_SEND",
      threadId: "SHOULD_NOT_SEND",
    };
  };

  await assert.rejects(
    () => processOutreachJob(job, sendDraft),
    NonRetryableOutreachJobError,
  );

  const result = await db.query<{ send_status: string }>(
    `
      SELECT send_status
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  assert.equal(result.rows[0]?.send_status, "pending");
  assert.equal(sendCalled, false);
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
