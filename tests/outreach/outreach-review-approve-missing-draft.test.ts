// tests/outreach/outreach-review-approve-missing-draft.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { approveOutreachDraft } from "../../src/outreach/outreach-review-actions.js";
import { createTestProspect } from "../helpers/test-helpers.js";

test("Outreach review approval: rejects a missing draft", async (t) => {
  const prospectId = await createTestProspect({
    companyName: "Missing Draft Company",
    contactEmail: "missing-draft@devbytaylor.com",
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

  const result = await approveOutreachDraft(
    prospectId,
    "11111111-1111-4111-8111-111111111111",
  );

  assert.equal(result.approved, false);
});
