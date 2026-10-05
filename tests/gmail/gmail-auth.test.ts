// tests/gmail/gmail-auth.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadGmailCredentials } from "../../src/gmail/gmail-auth.js";

test("Gmail auth: loads complete OAuth credentials", () => {
  const credentials = loadGmailCredentials({
    GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
    GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
    GOOGLE_REFRESH_TOKEN: "TEST_REFRESH_TOKEN",
  });

  assert.deepEqual(credentials, {
    clientId: "TEST_CLIENT_ID",
    clientSecret: "TEST_CLIENT_SECRET",
    refreshToken: "TEST_REFRESH_TOKEN",
  });
});
