// tests/jobs/process-outreach-job-uncertain.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import type { GmailDraftSender } from "../../src/gmail/gmail-types.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { processOutreachJob } from "../../src/jobs/process-outreach-job.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job processing: uncertain Gmail result requires reconciliation", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    gmailDraftId: "TEST_UNCERTAIN_GMAIL_DRAFT",
  });

  const job = await createOutreachJob(draftId);

  const sendDraft: GmailDraftSender = async () => {
    return {
      status: "uncertain",
      error: "Simulated Gmail timeout",
    };
  };

  await assert.rejects(
    () => processOutreachJob(job, sendDraft),
    NonRetryableOutreachJobError,
  );

  const draftResult = await db.query<{
    send_status: string;
    send_error: string | null;
    reconciliation_at: Date | null;
  }>(
    `
      SELECT
        send_status,
        send_error,
        reconciliation_at
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  const draft = draftResult.rows[0];

  assert.ok(draft);
  assert.equal(draft.send_status, "needs_reconciliation");
  assert.equal(draft.send_error, "Simulated Gmail timeout");
  assert.notEqual(draft.reconciliation_at, null);

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "send_reconciliation");
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
