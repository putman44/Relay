// tests/operator/outreach-operator-reconcile-missing-job-id.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects reconciliation without a job ID", () => {
  assert.throws(
    () =>
      parseOutreachOperatorArgs([
        "reconcile-not-sent",
        "--job",
        "--confirm-not-sent",
      ]),
    {
      message: "Missing job ID after --job",
    },
  );
});
