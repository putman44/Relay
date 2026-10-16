import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createGmailDraftCreator, type GmailDraftCreationApi } from "../../src/gmail/gmail-draft-creator.js";

test("Gmail draft creator: calls create with raw MIME and retries disabled", async () => {
  const create = createGmailDraftCreator({ users: { drafts: {
    create: async (request, options) => {
      assert.deepEqual(request, { userId: "me", requestBody: { message: { raw: "encoded-mime" } } });
      assert.deepEqual(options, { retry: false });
      return { data: { id: "draft-1", message: { id: "message-1", threadId: "thread-1" } } };
    },
  } } });
  assert.deepEqual(await create("encoded-mime"), { draftId: "draft-1", messageId: "message-1", threadId: "thread-1" });
});

test("Gmail draft creator: rejects incomplete identifiers without retrying", async () => {
  for (const data of [{}, { id: "draft-1" }, { id: "draft-1", message: { id: "message-1", threadId: " " } }]) {
    let calls = 0;
    const api: GmailDraftCreationApi = { users: { drafts: { create: async () => {
      calls++;
      return { data };
    } } } };
    await assert.rejects(createGmailDraftCreator(api)("raw"), /incomplete identifiers/);
    assert.equal(calls, 1);
  }
});

test("Gmail draft creator: propagates uncertain API errors without retrying", async () => {
  let calls = 0;
  const create = createGmailDraftCreator({ users: { drafts: { create: async () => {
    calls++;
    throw new Error("connection lost");
  } } } });
  await assert.rejects(create("raw"), /connection lost/);
  assert.equal(calls, 1);
});
