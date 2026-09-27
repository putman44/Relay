// src/gmail-reconciliation.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "./db.js";
import { fakeGmailSend } from "./fake-gmail.js";
import { handleGmailSendResult } from "./handle-gmail-result.js";
import { claimOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";
import { createTestDraft, createTestProspect } from "./test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("marks an uncertain Gmail send for reconciliation", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  testDraftId = draftId;

  console.log("Created draft:", draftId);

  const claim = await claimOutreachSend(prospectId, draftId);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const fakeGmailResult = await fakeGmailSend(true);
  await handleGmailSendResult(prospectId, draftId, fakeGmailResult);

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

  console.log("\nAll reconciliation assertions passed.");

  console.log("\nFinal draft state:");
  console.log(draftResultAfterSend.rows[0]);
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
