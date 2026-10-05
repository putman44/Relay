// tests/gmail/gmail-draft-sender.test.ts

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createGmailDraftSender,
  type GmailDraftApi,
} from "../../src/gmail/gmail-draft-sender.js";

test("Gmail draft sender: sends the exact Gmail draft and returns message IDs", async () => {
  let receivedUserId: string | null = null;
  let receivedDraftId: string | null = null;

  const gmailApi: GmailDraftApi = {
    users: {
      drafts: {
        send: async (request) => {
          receivedUserId = request.userId;
          receivedDraftId = request.requestBody.id;

          return {
            data: {
              id: "TEST_REAL_MESSAGE_ID",
              threadId: "TEST_REAL_THREAD_ID",
            },
          };
        },
      },
    },
  };

  const sendDraft = createGmailDraftSender(gmailApi);

  const result = await sendDraft("TEST_REAL_GMAIL_DRAFT");

  assert.equal(receivedUserId, "me");
  assert.equal(receivedDraftId, "TEST_REAL_GMAIL_DRAFT");

  assert.deepEqual(result, {
    status: "sent",
    messageId: "TEST_REAL_MESSAGE_ID",
    threadId: "TEST_REAL_THREAD_ID",
  });
});
