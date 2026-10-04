// src/outreach-reconciliation-guard.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { markOutreachNeedsReconciliation } from "../../src/outreach/outreach-send.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;
let testDraftId: string | null = null;

test("Outreach reconciliation guard: rejects reconciliation when the draft is still pending", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });
  testDraftId = draftId;

  const result = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "TEST_SHOULD_NOT_RECONCILE",
  );

  assert.equal(result.completed, false);

  if (result.completed) {
    throw new Error("Expected reconciliation to be rejected");
  }

  assert.equal(
    result.reason,
    "Draft cannot enter reconciliation. Current send status: pending",
  );

  const draftResultAfterReconciliation = await db.query(
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

  const finalDraft = draftResultAfterReconciliation.rows[0];
  assert.ok(finalDraft, "Expected draft to still exist");

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");
  assert.equal(finalDraft.send_status, "pending");
  assert.equal(finalDraft.send_error, null);
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
