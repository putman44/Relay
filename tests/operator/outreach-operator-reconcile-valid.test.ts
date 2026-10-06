// tests/operator/outreach-operator-reconcile-valid.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

const jobId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator args: parses confirmed reconciliation command", () => {
  const result = parseOutreachOperatorArgs([
    "reconcile-not-sent",
    "--job",
    jobId,
    "--confirm-not-sent",
  ]);

  assert.deepEqual(result, {
    command: "reconcile-not-sent",
    jobId: jobId,
    confirmNotSent: true,
  });
});
