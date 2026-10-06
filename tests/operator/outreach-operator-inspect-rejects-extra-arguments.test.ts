// tests/operator/outreach-operator-inspect-rejects-extra-arguments.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects extra inspect arguments", () => {
  const jobId = "11111111-1111-4111-8111-111111111111";

  assert.throws(
    () => parseOutreachOperatorArgs(["inspect", "--job", jobId, "--garbage"]),
    { message: "Unexpected arguments for inspect" },
  );
});
