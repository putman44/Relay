// tests/operator/outreach-operator-reconcile-rejects-invalid-job-id.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects an invalid reconciliation job ID", () => {
  assert.throws(
    () =>
      parseOutreachOperatorArgs([
        "reconcile-not-sent",
        "--job",
        "fake-job",
        "--confirm-not-sent",
      ]),
    {
      message: "Invalid job ID: expected UUID",
    },
  );
});
