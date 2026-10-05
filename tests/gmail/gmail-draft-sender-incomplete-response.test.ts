// tests/gmail/gmail-draft-sender-incomplete-response.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createGmailDraftSender,
  type GmailDraftApi,
} from "../../src/gmail/gmail-draft-sender.js";

test("Gmail draft sender: rejects an incomplete Gmail response", async () => {
  const gmailApi: GmailDraftApi = {
    users: {
      drafts: {
        send: async () => {
          return {
            data: {
              id: "TEST_MESSAGE_ID",
              threadId: null,
            },
          };
        },
      },
    },
  };

  const sendDraft = createGmailDraftSender(gmailApi);

  await assert.rejects(
    () => sendDraft("TEST_INCOMPLETE_DRAFT"),
    /Gmail send returned incomplete message data/,
  );
});
