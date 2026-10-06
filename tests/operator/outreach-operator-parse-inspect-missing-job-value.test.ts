// tests/operator/outreach-operator-parse-inspect-missing-job-value.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects inspect when job ID is another option", () => {
  assert.throws(
    () => parseOutreachOperatorArgs(["inspect", "--job", "--foo"]),
    {
      message: "Missing job ID after --job",
    },
  );
});
