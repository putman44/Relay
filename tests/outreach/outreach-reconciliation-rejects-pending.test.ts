// tests/outreach/outreach-reconciliation-rejects-pending.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { resolveOutreachReconciliationAsNotSent } from "../../src/outreach/outreach-reconciliation.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach reconciliation: rejects a draft that is not awaiting reconciliation", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  const result = await resolveOutreachReconciliationAsNotSent(
    prospectId,
    draftId,
  );

  assert.equal(result.resolved, false);

  if (result.resolved) {
    throw new Error("Expected reconciliation to be rejected");
  }

  assert.equal(
    result.reason,
    "Prospect is not awaiting reconciliation. Current stage: draft_ready",
  );

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");

  const draftResult = await db.query(
    `
      SELECT
        send_status,
        review_status,
        send_error,
        reconciliation_at
      FROM message_drafts
      WHERE id = $1;
    `,
    [draftId],
  );

  const draft = draftResult.rows[0];

  assert.ok(draft);
  assert.equal(draft.send_status, "pending");
  assert.equal(draft.review_status, "approved");
  assert.equal(draft.send_error, null);
  assert.equal(draft.reconciliation_at, null);
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
