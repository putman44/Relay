// tests/jobs/resolve-outreach-job-draft-missing.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { NonRetryableOutreachJobError } from "../../src/jobs/non-retryable-job-error.js";
import type { OutreachJob } from "../../src/jobs/outreach-jobs.js";
import { resolveOutreachJobDraft } from "../../src/jobs/resolve-outreach-job-draft.js";

test("Outreach job draft resolution: missing draft is non-retryable", async () => {
  const job: OutreachJob = {
    id: "00000000-0000-0000-0000-000000000001",
    draft_id: "00000000-0000-0000-0000-000000000002",
    status: "processing",
    attempt_count: 1,
    available_at: new Date(),
    claimed_at: new Date(),
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  await assert.rejects(
    () => resolveOutreachJobDraft(job),
    NonRetryableOutreachJobError,
  );
});

after(async () => {
  await db.end();
});