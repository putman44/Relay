// tests/operator/outreach-operator-inspect-queue-excludes-completed.test.ts
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

test("Outreach operator inspect: excludes completed jobs from the default queue", async () => {
  prospectId = await createTestProspect({
    companyName: "Operator Completed Test",
    contactEmail: "completed@devbytaylor.com",
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "completed@devbytaylor.com",
    subject: "Operator completed test draft",
  });

  const job = await createOutreachJob(draftId);

  await db.query(
    `
      UPDATE outreach_jobs
      SET status = 'completed'
      WHERE id = $1;
    `,
    [job.id],
  );

  const results = await inspectOutreachQueue();

  const inspectedJob = results.find((result) => result.jobId === job.id);

  assert.equal(inspectedJob, undefined);
});
