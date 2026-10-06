// tests/operator/outreach-operator-parse-inspect-missing-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects inspect without a job ID", () => {
  assert.throws(() => parseOutreachOperatorArgs(["inspect", "--job"]), {
    message: "Missing job ID after --job",
  });
});
