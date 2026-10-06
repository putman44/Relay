// tests/operator/outreach-operator-parse-inspect-unknown-flag.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: rejects unknown inspect flag", () => {
  assert.throws(() => parseOutreachOperatorArgs(["inspect", "--foo"]), {
    message: "Unknown inspect option: --foo",
  });
});
