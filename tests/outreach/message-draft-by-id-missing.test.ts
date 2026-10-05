// tests/outreach/message-draft-by-id-missing.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";

test("Message draft lookup: returns null when the draft ID does not exist", async () => {
  const missingDraft = await getMessageDraftById(
    "00000000-0000-0000-0000-000000000000",
  );

  assert.equal(missingDraft, null);
});

after(async () => {
  await db.end();
});
