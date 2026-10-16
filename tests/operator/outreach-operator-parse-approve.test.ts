// tests/operator/outreach-operator-parse-approve.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

const prospectId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";

test("Outreach operator args: parses confirmed approval command", () => {
  const result = parseOutreachOperatorArgs([
    "approve",
    "--prospect",
    prospectId,
    "--draft",
    draftId,
    "--confirm-approval",
  ]);

  assert.deepEqual(result, {
    command: "approve",
    prospectId,
    draftId,
    confirmApproval: true,
  });
});
