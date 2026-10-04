// src/outreach-job-empty-claim.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { claimNextOutreachJob } from "../../src/outreach-jobs.js";

test("Outreach job empty claim: returns null when no pending job is available", async () => {
  const claimedJob = await claimNextOutreachJob();

  assert.equal(claimedJob, null);
});

after(async () => {
  await db.end();
});
