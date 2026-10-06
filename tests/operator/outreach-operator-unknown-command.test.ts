// tests/operator/outreach-operator-unknown-command.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects unknown command", () => {
  assert.throws(() => parseOutreachOperatorArgs(["delete-everything"]), {
    message: "Unknown outreach operator command: delete-everything",
  });
});
