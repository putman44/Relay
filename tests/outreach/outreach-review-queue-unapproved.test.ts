// tests/outreach/outreach-review-queue-unapproved.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: rejects an unapproved draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Queue Unapproved Company",
    contactEmail: "queue-unapproved@devbytaylor.com",
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
    recipientEmail: "queue-unapproved@devbytaylor.com",
    reviewStatus: "needs_review",
  });

  const result = await queueApprovedOutreachDraft(prospectId, draftId);

  assert.equal(result.queued, false);

  const jobResult = await db.query(
    `
      SELECT id
      FROM outreach_jobs
      WHERE draft_id = $1;
    `,
    [draftId],
  );

  assert.equal(jobResult.rowCount, 0);
});
