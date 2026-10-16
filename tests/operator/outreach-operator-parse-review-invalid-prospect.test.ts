// tests/operator/outreach-operator-parse-review-invalid-prospect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects review with an invalid prospect ID", () => {
  assert.throws(
    () => parseOutreachOperatorArgs(["review", "--prospect", "not-a-uuid"]),
    { message: "Invalid prospect ID: expected UUID" },
  );
});
