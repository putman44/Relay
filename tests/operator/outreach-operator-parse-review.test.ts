// tests/operator/outreach-operator-parse-review.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

const prospectId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator args: parses review command", () => {
  const result = parseOutreachOperatorArgs([
    "review",
    "--prospect",
    prospectId,
  ]);

  assert.deepEqual(result, {
    command: "review",
    prospectId,
  });
});
