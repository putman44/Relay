// tests/operator/outreach-operator-run-inspect-missing-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

const missingJobId = "22222222-2222-4222-8222-222222222222";

test("Outreach operator runner: rejects a missing requested job", async () => {
  await assert.rejects(
    () =>
      runOutreachOperator(
        ["inspect", "--job", missingJobId],
        {
          inspectJob: async () => null,
          inspectQueue: async () => [],
        },
        () => {
          throw new Error("Output should not be called");
        },
      ),
    {
      message: "Outreach job not found: 22222222-2222-4222-8222-222222222222",
    },
  );
});
