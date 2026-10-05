// tests/jobs/process-outreach-job-finalization-throws.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import type {
  GmailDraftSender,
  GmailResultFinalizer,
} from "../../src/gmail/gmail-types.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job processing: finalization failure after confirmed send is non-retryable", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    gmailDraftId: "TEST_FINALIZATION_FAILURE_DRAFT",
  });

  const job = await createOutreachJob(draftId);

  const sendDraft: GmailDraftSender = async () => {
    return {
      status: "sent",
      messageId: "TEST_CONFIRMED_MESSAGE",
      threadId: "TEST_CONFIRMED_THREAD",
    };
  };

  const finalizeResult: GmailResultFinalizer = async () => {
    throw new Error("Simulated database finalization failure");
  };

  await assert.rejects(
    () => processOutreachJob(job, sendDraft, finalizeResult),
    NonRetryableOutreachJobError,
  );

  const draftResult = await db.query<{ send_status: string }>(
    `
      SELECT send_status
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  assert.equal(draftResult.rows[0]?.send_status, "sending");
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
