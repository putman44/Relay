// tests/outreach/outreach-review-queue-invalid-stage.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: rejects a prospect that is not draft ready", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Queue Invalid Stage Company",
    contactEmail: "queue-invalid-stage@devbytaylor.com",
    stage: "researching",
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
    recipientEmail: "queue-invalid-stage@devbytaylor.com",
    reviewStatus: "approved",
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
