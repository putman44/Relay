// tests/worker/live-outreach-send-guard-enabled.test.ts

import { test } from "node:test";

import { assertLiveOutreachSendEnabled } from "../../src/jobs/live-outreach-send-guard.js";

test("Live outreach guard: allows live sending when explicitly enabled", () => {
  assertLiveOutreachSendEnabled({
    RELAY_ENABLE_LIVE_OUTREACH_SEND: "true",
  });
});
