// tests/operator/outreach-operator-inspect-queue.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { createOutreachJob } from "../../src/jobs/outreach-jobs.js";
import { inspectOutreachQueue } from "../../src/operator/outreach-operator-inspect.js";
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

test("Outreach operator inspect: includes a non-completed outreach job", async () => {
  prospectId = await createTestProspect({
    companyName: "Operator Queue Test",
    contactEmail: "queue@devbytaylor.com",
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "queue@devbytaylor.com",
    subject: "Operator queue test draft",
  });

  const job = await createOutreachJob(draftId);

  const results = await inspectOutreachQueue();

  const inspectedJob = results.find((result) => result.jobId === job.id);

  assert.ok(inspectedJob);
  assert.equal(inspectedJob.jobStatus, "pending");
  assert.equal(inspectedJob.companyName, "Operator Queue Test");
});
