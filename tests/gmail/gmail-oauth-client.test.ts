// tests/gmail/gmail-oauth-client.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createGmailOAuthClient } from "../../src/gmail/gmail-auth.js";

test("Gmail auth: configures OAuth client with refresh token", () => {
  const oauthClient = createGmailOAuthClient({
    clientId: "TEST_CLIENT_ID",
    clientSecret: "TEST_CLIENT_SECRET",
    refreshToken: "TEST_REFRESH_TOKEN",
  });

  assert.equal(oauthClient.credentials.refresh_token, "TEST_REFRESH_TOKEN");
});
