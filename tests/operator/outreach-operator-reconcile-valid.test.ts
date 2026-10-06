// tests/operator/outreach-operator-reconcile-valid.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: parses confirmed reconciliation command", () => {
  const result = parseOutreachOperatorArgs([
    "reconcile-not-sent",
    "--job",
    "job-123",
    "--confirm-not-sent",
  ]);

  assert.deepEqual(result, {
    command: "reconcile-not-sent",
    jobId: "job-123",
    confirmNotSent: true,
  });
});
