// tests/operator/outreach-operations-overdue-ready-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach operations: alerts on an overdue ready job", async (t) => {
  const now = new Date();
  const baseline = await getOutreachOperationalStatus({ now });
  const availableAt = new Date(now.getTime() - 60 * 60_000);
  const prospectId = await createTestProspect({
    companyName: "Operations Overdue Job Company",
    contactEmail: "operations-overdue-job@devbytaylor.com",
  });

  t.after(async () => {
    await db.query("DELETE FROM prospects WHERE id = $1;", [prospectId]);
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "operations-overdue-job@devbytaylor.com",
  });

  await db.query(
    `
      INSERT INTO outreach_jobs (draft_id, available_at)
      VALUES ($1, $2);
    `,
    [draftId, availableAt],
  );

  const status = await getOutreachOperationalStatus({
    now,
    readyPendingMinutes: 30,
  });
  const overdueAlert = status.alerts.find(
    (alert) => alert.code === "overdue_ready_jobs",
  );

  assert.equal(status.healthy, false);
  assert.equal(
    status.counts.readyPendingJobs,
    baseline.counts.readyPendingJobs + 1,
  );
  assert.equal(
    status.counts.overdueReadyJobs,
    baseline.counts.overdueReadyJobs + 1,
  );
  assert.deepEqual(overdueAlert, {
    code: "overdue_ready_jobs",
    count: status.counts.overdueReadyJobs,
  });
});
