// tests/operator/outreach-operator-inspect-job.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { inspectOutreachJob } from "../../src/operator/outreach-operator-inspect.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let prospectId: string | null = null;

after(async () => {
  if (prospectId) {
    await db.query("DELETE FROM prospects WHERE id = $1", [prospectId]);
  }

  await db.end();
});

test("Outreach operator inspect: returns the exact joined outreach job", async () => {
  prospectId = await createTestProspect({
    companyName: "Operator Inspect Test",
    contactEmail: "inspect@devbytaylor.com",
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "inspect@devbytaylor.com",
    subject: "Operator inspect test draft",
  });

  const job = await createOutreachJob(draftId);

  const result = await inspectOutreachJob(job.id);

  assert.ok(result);

  assert.equal(result.jobId, job.id);
  assert.equal(result.jobStatus, "pending");
  assert.equal(result.attemptCount, 0);

  assert.equal(result.draftId, draftId);
  assert.equal(result.subject, "Operator inspect test draft");
  assert.equal(result.recipientEmail, "inspect@devbytaylor.com");
  assert.equal(result.reviewStatus, "approved");

  assert.equal(result.prospectId, prospectId);
  assert.equal(result.companyName, "Operator Inspect Test");
  assert.equal(result.contactEmail, "inspect@devbytaylor.com");
  assert.equal(result.prospectStage, "draft_ready");
});
