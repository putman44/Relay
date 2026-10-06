// tests/operator/outreach-operator-reconcile-requires-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects reconciliation without job option", () => {
  assert.throws(
    () =>
      parseOutreachOperatorArgs(["reconcile-not-sent", "--confirm-not-sent"]),
    {
      message: "Missing required --job",
    },
  );
});
