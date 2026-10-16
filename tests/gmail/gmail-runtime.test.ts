// tests/gmail/gmail-runtime.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createProductionGmailDraftSender } from "../../src/gmail/gmail-runtime.js";
import { GmailPreflightError } from "../../src/gmail/gmail-preflight-error.js";

test("Gmail runtime: creates a production draft sender from environment credentials", () => {
  const sendDraft = createProductionGmailDraftSender({
    GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
    GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
    GOOGLE_REFRESH_TOKEN: "TEST_REFRESH_TOKEN",
  });

  assert.equal(typeof sendDraft, "function");
});

test("Gmail runtime: production sender requires approved content before contacting Gmail", async () => {
  const sendDraft = createProductionGmailDraftSender({
    GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
    GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
    GOOGLE_REFRESH_TOKEN: "TEST_REFRESH_TOKEN",
  });
  await assert.rejects(sendDraft("TEST_DRAFT"), GmailPreflightError);
});
