// tests/outreach/outreach-reconciliation-not-sent.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { resolveOutreachReconciliationAsNotSent } from "../../src/outreach/outreach-reconciliation.js";
import {
  claimOutreachSend,
  markOutreachNeedsReconciliation,
} from "../../src/outreach/outreach-send.js";
import { getProspectById } from "../../src/outreach/prospects.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach reconciliation: confirmed not sent returns draft to pending", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
  });

  const claim = await claimOutreachSend(prospectId, draftId);

  if (!claim.claimed) {
    throw new Error(`Could not claim draft: ${claim.reason}`);
  }

  const uncertain = await markOutreachNeedsReconciliation(
    prospectId,
    draftId,
    "TEST_UNCERTAIN_SEND",
  );

  if (!uncertain.completed) {
    throw new Error(`Could not mark reconciliation: ${uncertain.reason}`);
  }

  const resolved = await resolveOutreachReconciliationAsNotSent(
    prospectId,
    draftId,
  );

  if (!resolved.resolved) {
    throw new Error(`Could not resolve reconciliation: ${resolved.reason}`);
  }

  assert.equal(resolved.draft.send_status, "pending");
  assert.equal(resolved.draft.send_error, null);
  assert.equal(resolved.draft.reconciliation_at, null);
  assert.equal(resolved.draft.review_status, "approved");

  const prospect = await getProspectById(prospectId);

  assert.equal(prospect?.stage, "draft_ready");
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
