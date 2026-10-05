// tests/gmail/gmail-auth-missing-refresh-token.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadGmailCredentials } from "../../src/gmail/gmail-auth.js";

test("Gmail auth: rejects missing refresh token", () => {
  assert.throws(
    () =>
      loadGmailCredentials({
        GOOGLE_CLIENT_ID: "TEST_CLIENT_ID",
        GOOGLE_CLIENT_SECRET: "TEST_CLIENT_SECRET",
      }),
    /GOOGLE_REFRESH_TOKEN is not set/,
  );
});
