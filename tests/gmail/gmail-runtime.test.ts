// tests/gmail/gmail-runtime.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createProductionGmailDraftSender } from "../../src/gmail/gmail-runtime.js";

test("Gmail runtime: creates a production draft sender from environment credentials", () => {
  const sendDraft = createProductionGmailDraftSender({
    GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
    GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
    GOOGLE_REFRESH_TOKEN: "TEST_REFRESH_TOKEN",
  });

  assert.equal(typeof sendDraft, "function");
});
