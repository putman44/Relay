// tests/outreach/outreach-review-queue-concurrent.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: allows only one concurrent queue attempt", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Concurrent Queue Company",
    contactEmail: "concurrent-queue@devbytaylor.com",
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
    recipientEmail: "concurrent-queue@devbytaylor.com",
    reviewStatus: "approved",
  });

  const results = await Promise.all([
    queueApprovedOutreachDraft(prospectId, draftId),
    queueApprovedOutreachDraft(prospectId, draftId),
  ]);

  assert.equal(results.filter((result) => result.queued).length, 1);
  assert.equal(results.filter((result) => !result.queued).length, 1);

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
