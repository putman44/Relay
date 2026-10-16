// tests/operator/outreach-operations-invalid-threshold.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getOutreachOperationalStatus } from "../../src/operator/outreach-operations.js";

test("Outreach operations: rejects an invalid monitoring threshold", async () => {
  await assert.rejects(
    getOutreachOperationalStatus({ staleProcessingMinutes: 0 }),
    { message: "staleProcessingMinutes must be a positive integer" },
  );
});
