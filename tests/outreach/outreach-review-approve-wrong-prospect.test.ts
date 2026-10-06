// tests/outreach/outreach-review-approve-wrong-prospect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";
import { approveOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review approval: rejects a draft belonging to another prospect", async (t) => {
  const ownerProspectId = await createTestProspect({
    companyName: "Draft Owner Company",
    contactEmail: "draft-owner@devbytaylor.com",
  });

  const wrongProspectId = await createTestProspect({
    companyName: "Wrong Prospect Company",
    contactEmail: "wrong-prospect@devbytaylor.com",
  });

  t.after(async () => {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = ANY($1::uuid[]);
      `,
      [[ownerProspectId, wrongProspectId]],
    );
  });

  const draftId = await createTestDraft({
    prospectId: ownerProspectId,
    recipientEmail: "draft-owner@devbytaylor.com",
    reviewStatus: "needs_review",
  });

  const result = await approveOutreachDraft(wrongProspectId, draftId);

  assert.equal(result.approved, false);

  const draft = await getMessageDraftById(draftId);

  assert.ok(draft);
  assert.equal(draft.review_status, "needs_review");
});
