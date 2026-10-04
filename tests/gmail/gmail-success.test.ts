// src/gmail-success.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { fakeGmailSend } from "../../src/fake-gmail.js";
import { handleGmailSendResult } from "../../src/handle-gmail-result.js";
import { claimOutreachSend } from "../../src/outreach-send.js";
import { getProspectById } from "../../src/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Gmail success: marks the draft sent after a confirmed Gmail send", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  testDraftId = draftId;

  const claim = await claimOutreachSend(prospectId, draftId);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const fakeGmailSuccess = await fakeGmailSend(false);

  await handleGmailSendResult(prospectId, draftId, fakeGmailSuccess);

  const draftResultAfterSend = await db.query(
    `
    SELECT
      send_status,
      sent_message_id,
      gmail_thread_id,
      sent_at,
      reconciliation_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterSend.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");
  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "outreach_sent");
  assert.equal(finalDraft.send_status, "sent");
  assert.equal(finalDraft.sent_message_id, "TEST_MESSAGE_ID");
  assert.equal(finalDraft.gmail_thread_id, "TEST_THREAD_ID");
  assert.notEqual(finalDraft.sent_at, null);
  assert.equal(finalDraft.reconciliation_at, null);
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

  if (testDraftId) {
    const remainingDraft = await db.query(
      `
        SELECT id
        FROM message_drafts
        WHERE id = $1;
      `,
      [testDraftId],
    );

    assert.equal(
      remainingDraft.rowCount,
      0,
      "Expected draft to be deleted by ON DELETE CASCADE",
    );
  }

  await db.end();
});
