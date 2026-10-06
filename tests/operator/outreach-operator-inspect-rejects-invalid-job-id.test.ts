// tests/operator/outreach-operator-inspect-rejects-invalid-job-id.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects an invalid inspect job ID", () => {
  assert.throws(
    () => parseOutreachOperatorArgs(["inspect", "--job", "fake-job"]),
    { message: "Invalid job ID: expected UUID" },
  );
});
