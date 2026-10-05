// tests/gmail/gmail-reconciliation.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { fakeGmailSend } from "../../src/gmail/fake-gmail.js";
import { handleGmailSendResult } from "../../src/gmail/handle-gmail-result.js";
import { claimOutreachSend } from "../../src/outreach/outreach-send.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Gmail reconciliation: marks an uncertain Gmail send for reconciliation", async () => {
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

  const fakeGmailResult = await fakeGmailSend(true);

  const completion = await handleGmailSendResult(
    prospectId,
    draftId,
    fakeGmailResult,
  );

  if (!completion.completed) {
    throw new Error(`Expected reconciliation completion: ${completion.reason}`);
  }

  assert.equal(completion.draft.id, draftId);
  assert.equal(completion.draft.send_status, "needs_reconciliation");

  const draftResultAfterSend = await db.query(
    `
    SELECT send_status, send_error, reconciliation_at
    FROM message_drafts
    WHERE id = $1;
  `,
    [draftId],
  );

  const finalDraft = draftResultAfterSend.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");
  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "send_reconciliation");
  assert.equal(finalDraft.send_status, "needs_reconciliation");
  assert.equal(finalDraft.send_error, "Simulated Gmail timeout");
  assert.notEqual(finalDraft.reconciliation_at, null);
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
