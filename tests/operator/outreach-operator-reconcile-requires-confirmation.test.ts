// tests/operator/outreach-operator-reconcile-requires-confirmation.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects reconciliation without confirmation", () => {
  assert.throws(
    () => parseOutreachOperatorArgs(["reconcile-not-sent", "--job", "job-123"]),
    {
      message: "Missing required --confirm-not-sent",
    },
  );
});
