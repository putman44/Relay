// tests/operator/outreach-operator-parse-inspect.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: parses inspect command", () => {
  const result = parseOutreachOperatorArgs(["inspect"]);

  assert.deepEqual(result, {
    command: "inspect",
    jobId: null,
  });
});
