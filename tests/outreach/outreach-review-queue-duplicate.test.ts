// tests/outreach/outreach-review-queue-duplicate.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: rejects duplicate queueing without creating another job", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Duplicate Queue Company",
    contactEmail: "duplicate-queue@devbytaylor.com",
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
    recipientEmail: "duplicate-queue@devbytaylor.com",
    reviewStatus: "approved",
  });

  const firstResult = await queueApprovedOutreachDraft(prospectId, draftId);

  assert.equal(firstResult.queued, true);

  const secondResult = await queueApprovedOutreachDraft(prospectId, draftId);

  assert.equal(secondResult.queued, false);

  const jobsResult = await db.query(
    `
      SELECT id
      FROM outreach_jobs
      WHERE draft_id = $1;
    `,
    [draftId],
  );

  assert.equal(jobsResult.rowCount, 1);
});
