// tests/worker/live-outreach-send-guard.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { assertLiveOutreachSendEnabled } from "../../src/jobs/live-outreach-send-guard.js";

test("Live outreach guard: rejects when live sending is not explicitly enabled", () => {
  assert.throws(
    () => assertLiveOutreachSendEnabled({}),
    /Live outreach sending is disabled/,
  );
});