// tests/operator/outreach-operator-run-reconciliation-blocked.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

test("Outreach operator runner: blocks reconciliation execution until implemented", async () => {
  await assert.rejects(
    () =>
      runOutreachOperator(
        ["reconcile-not-sent", "--job", "job-123", "--confirm-not-sent"],
        {
          inspectJob: async () => null,
          inspectQueue: async () => [],
        },
        () => {
          throw new Error("Output should not be called");
        },
      ),
    {
      message: "Reconciliation execution not implemented",
    },
  );
});
