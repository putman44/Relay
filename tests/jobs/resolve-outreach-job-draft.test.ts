// tests/jobs/resolve-outreach-job-draft.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { resolveOutreachJobDraft } from "../../src/jobs/resolve-outreach-job-draft.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Outreach job draft resolution: returns the draft referenced by the job", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const draftId = await createTestDraft({
    prospectId,
    subject: "Resolver target draft",
  });

  const job = await createOutreachJob(draftId);

  const draft = await resolveOutreachJobDraft(job);

  assert.equal(draft.id, draftId);
  assert.equal(draft.prospect_id, prospectId);
  assert.equal(draft.subject, "Resolver target draft");
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
