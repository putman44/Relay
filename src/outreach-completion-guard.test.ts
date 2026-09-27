// src/outreach-completion-guard.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { completeOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("rejects completion when the draft is still pending", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const result = await completeOutreachSend(
    prospectId,
    draftId,
    "TEST_SHOULD_NOT_SEND",
    "TEST_SHOULD_NOT_THREAD",
  );

  assert.equal(result.completed, false);

  if (result.completed) {
    throw new Error("Expected completion to be rejected");
  }

  assert.equal(
    result.reason,
    "Draft cannot be completed. Current send status: pending",
  );

  const draftResultAfterCompletion = await db.query(
    `
    SELECT
      send_status,
      review_status,
      sent_message_id,
      gmail_thread_id,
      sent_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterCompletion.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");
  assert.equal(finalDraft.send_status, "pending");
  assert.equal(finalDraft.review_status, "approved");
  assert.equal(finalDraft.sent_message_id, null);
  assert.equal(finalDraft.gmail_thread_id, null);
  assert.equal(finalDraft.sent_at, null);
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
