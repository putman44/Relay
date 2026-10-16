// tests/operator/outreach-operations-reconciliation.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../src/db.js";
import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

test("Outreach operations: alerts on reconciliation state", async (t) => {
  const baseline = await getOutreachOperationalStatus();
  const prospectId = await createTestProspect({
    companyName: "Operations Reconciliation Company",
    contactEmail: "operations-reconciliation@devbytaylor.com",
    stage: "send_reconciliation",
  });

  t.after(async () => {
    await db.query("DELETE FROM prospects WHERE id = $1;", [prospectId]);
  });

  const draftId = await createTestDraft({
    prospectId,
    recipientEmail: "operations-reconciliation@devbytaylor.com",
  });

  await db.query(
    `
      UPDATE message_drafts
      SET send_status = 'needs_reconciliation'
      WHERE id = $1;
    `,
    [draftId],
  );

  const status = await getOutreachOperationalStatus();
  const draftAlert = status.alerts.find(
    (alert) => alert.code === "drafts_need_reconciliation",
  );
  const prospectAlert = status.alerts.find(
    (alert) => alert.code === "prospects_need_reconciliation",
  );

  assert.equal(status.healthy, false);
  assert.equal(
    status.counts.draftsNeedingReconciliation,
    baseline.counts.draftsNeedingReconciliation + 1,
  );
  assert.equal(
    status.counts.prospectsNeedingReconciliation,
    baseline.counts.prospectsNeedingReconciliation + 1,
  );
  assert.deepEqual(draftAlert, {
    code: "drafts_need_reconciliation",
    count: status.counts.draftsNeedingReconciliation,
  });
  assert.deepEqual(prospectAlert, {
    code: "prospects_need_reconciliation",
    count: status.counts.prospectsNeedingReconciliation,
  });
});
