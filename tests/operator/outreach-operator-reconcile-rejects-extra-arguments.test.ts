// tests/operator/outreach-operator-reconcile-rejects-extra-arguments.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects extra reconciliation arguments", () => {
  const jobId = "11111111-1111-4111-8111-111111111111";

  assert.throws(
    () =>
      parseOutreachOperatorArgs([
        "reconcile-not-sent",
        "--job",
        jobId,
        "--confirm-not-sent",
        "--garbage",
      ]),
    { message: "Unexpected arguments for reconcile-not-sent" },
  );
});
