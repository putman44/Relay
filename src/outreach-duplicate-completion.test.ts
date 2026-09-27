// src/outreach-duplicate-completion.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { claimOutreachSend, completeOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Outreach duplicate completion: rejects duplicate completion after the draft is already sent", async () => {
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

  const firstCompletion = await completeOutreachSend(
    prospectId,
    draftId,
    "TEST_FIRST_MESSAGE",
    "TEST_FIRST_THREAD",
  );

  if (!firstCompletion.completed) {
    throw new Error(`First completion failed: ${firstCompletion.reason}`);
  }

  const secondCompletion = await completeOutreachSend(
    prospectId,
    draftId,
    "TEST_SECOND_MESSAGE",
    "TEST_SECOND_THREAD",
  );

  assert.equal(secondCompletion.completed, false);

  if (secondCompletion.completed) {
    throw new Error("Expected duplicate completion to be rejected");
  }

  assert.equal(
    secondCompletion.reason,
    "Draft cannot be completed. Current send status: sent",
  );

  const draftResult = await db.query(
    `
    SELECT
      send_status,
      sent_message_id,
      gmail_thread_id,
      sent_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResult.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);
  assert.equal(prospect?.stage, "outreach_sent");

  assert.equal(finalDraft.send_status, "sent");
  assert.equal(finalDraft.sent_message_id, "TEST_FIRST_MESSAGE");
  assert.equal(finalDraft.gmail_thread_id, "TEST_FIRST_THREAD");
  assert.notEqual(finalDraft.sent_at, null);
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
