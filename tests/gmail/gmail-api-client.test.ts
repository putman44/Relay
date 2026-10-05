// tests/gmail/gmail-api-client.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createGmailApi,
  createGmailOAuthClient,
} from "../../src/gmail/gmail-auth.js";
import { createGmailDraftSender } from "../../src/gmail/gmail-draft-sender.js";

test("Gmail auth: creates Gmail API compatible with draft sender", () => {
  const oauthClient = createGmailOAuthClient({
    clientId: "TEST_CLIENT_ID",
    clientSecret: "TEST_CLIENT_SECRET",
    refreshToken: "TEST_REFRESH_TOKEN",
  });

  const gmailApi = createGmailApi(oauthClient);

  assert.equal(typeof gmailApi.users.drafts.send, "function");

  const sendDraft = createGmailDraftSender(gmailApi);

  assert.equal(typeof sendDraft, "function");
});
