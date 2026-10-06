// tests/operator/outreach-operator-parse-inspect-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

test("Outreach operator args: parses inspect command with job ID", () => {
  const result = parseOutreachOperatorArgs(["inspect", "--job", "job-123"]);

  assert.deepEqual(result, {
    command: "inspect",
    jobId: "job-123",
  });
});
