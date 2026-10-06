// tests/operator/outreach-operator-run-inspect-missing-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runOutreachOperator } from "../../src/operator/outreach-operator-run.js";

test("Outreach operator runner: rejects a missing requested job", async () => {
  await assert.rejects(
    () =>
      runOutreachOperator(
        ["inspect", "--job", "missing-job"],
        {
          inspectJob: async () => null,
          inspectQueue: async () => [],
        },
        () => {
          throw new Error("Output should not be called");
        },
      ),
    {
      message: "Outreach job not found: missing-job",
    },
  );
});
