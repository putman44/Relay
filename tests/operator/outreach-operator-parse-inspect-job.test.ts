// tests/operator/outreach-operator-parse-inspect-job.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseOutreachOperatorArgs } from "../../src/operator/outreach-operator-args.js";

const jobId = "11111111-1111-4111-8111-111111111111";

test("Outreach operator args: parses inspect command with job ID", () => {
  const result = parseOutreachOperatorArgs(["inspect", "--job", jobId]);

  assert.deepEqual(result, {
    command: "inspect",
    jobId: jobId,
  });
});
