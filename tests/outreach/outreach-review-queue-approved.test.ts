// tests/outreach/outreach-review-queue-approved.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: creates a pending job for an approved draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Queue Approved Company",
    contactEmail: "queue-approved@devbytaylor.com",
  });

  t.after(async () => {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = $1;
      `,
      [prospectId],
    );
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "queue-approved@devbytaylor.com",
    reviewStatus: "approved",
  });

  const result = await queueApprovedOutreachDraft(prospectId, draftId);

  if (!result.queued) {
    assert.fail(result.reason);
  }

  assert.equal(result.job.draft_id, draftId);
  assert.equal(result.job.status, "pending");
  assert.equal(result.job.attempt_count, 0);
});
