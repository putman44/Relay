// tests/worker/outreach-worker-runtime.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createProductionOutreachProcessor } from "../../src/jobs/outreach-worker-runtime.js";

test("Outreach worker runtime: creates a production processor", () => {
  const processJob = createProductionOutreachProcessor({
    GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
    GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
    GOOGLE_REFRESH_TOKEN: "TEST_REFRESH_TOKEN",
  });

  assert.equal(typeof processJob, "function");
});
