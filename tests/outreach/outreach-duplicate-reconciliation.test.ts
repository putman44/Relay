// src/outreach-duplicate-reconciliation.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import {
  claimOutreachSend,
  markOutreachNeedsReconciliation,
} from "../../src/outreach-send.js";
import { getProspectById } from "../../src/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Outreach duplicate reconciliation: rejects duplicate reconciliation without mutating the original record", async () => {
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

  const firstReconciliation = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "TEST_FIRST_UNCERTAIN_ERROR",
  );

  if (!firstReconciliation.completed) {
    throw new Error(
      `First reconciliation failed: ${firstReconciliation.reason}`,
    );
  }

  const firstReconciliationAt = firstReconciliation.draft.reconciliation_at;

  const secondReconciliation = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "TEST_SECOND_UNCERTAIN_ERROR",
  );

  assert.equal(secondReconciliation.completed, false);

  if (secondReconciliation.completed) {
    throw new Error("Expected duplicate reconciliation to be rejected");
  }

  assert.equal(
    secondReconciliation.reason,
    "Draft cannot enter reconciliation. Current send status: needs_reconciliation",
  );

  const draftResult = await db.query(
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

  const finalDraft = draftResult.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);
  assert.equal(prospect?.stage, "send_reconciliation");
  assert.equal(finalDraft.send_status, "needs_reconciliation");
  assert.equal(finalDraft.send_error, "TEST_FIRST_UNCERTAIN_ERROR");
  assert.deepEqual(finalDraft.reconciliation_at, firstReconciliationAt);
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
