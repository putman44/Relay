// tests/operator/outreach-operator-parse-approve-invalid-draft.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

const prospectId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator args: rejects approval with an invalid draft ID", () => {
  assert.throws(
    () =>
      parseOutreachOperatorArgs([
        "approve",
        "--prospect",
        prospectId,
        "--draft",
        "not-a-uuid",
        "--confirm-approval",
      ]),
    { message: "Invalid draft ID: expected UUID" },
  );
});
