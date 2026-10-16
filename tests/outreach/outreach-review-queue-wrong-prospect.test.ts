// tests/outreach/outreach-review-queue-wrong-prospect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { queueApprovedOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach review queue: rejects a draft belonging to another prospect", async (t) => {
  const ownerProspectId = await createTestProspect({
    companyName: "Queue Draft Owner Company",
    contactEmail: "queue-draft-owner@devbytaylor.com",
  });

  const wrongProspectId = await createTestProspect({
    companyName: "Queue Wrong Prospect Company",
    contactEmail: "queue-wrong-prospect@devbytaylor.com",
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
    recipientEmail: "queue-draft-owner@devbytaylor.com",
    reviewStatus: "approved",
  });

  const result = await queueApprovedOutreachDraft(wrongProspectId, draftId);

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
