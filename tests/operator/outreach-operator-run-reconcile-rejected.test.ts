// tests/operator/outreach-operator-run-reconcile-rejected.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const jobId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator runner: rejects an unsuccessful reconciliation", async () => {
  let outputCalled = false;

  await assert.rejects(
    () =>
      runOutreachOperator(
        ["reconcile-not-sent", "--job", jobId, "--confirm-not-sent"],
        {
          inspectJob: async () => null,
          inspectQueue: async () => [],
          reconcileNotSent: async () => ({
            reconciled: false,
            reason: "Outreach job cannot be reconciled",
          }),
        },
        () => {
          outputCalled = true;
        },
      ),
    {
      message: "Outreach job cannot be reconciled",
    },
  );

  assert.equal(outputCalled, false);
});
