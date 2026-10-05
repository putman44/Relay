// tests/outreach/message-draft-by-id.test.ts
import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { getMessageDraftById } from "../../src/outreach/message-drafts.js";
import {
  createTestDraft,
  createTestProspect,
} from "../helpers/test-helpers.js";

let testProspectId: string | null = null;

test("Message draft lookup: returns the exact draft by ID", async () => {
  const prospectId = await createTestProspect();
  testProspectId = prospectId;

  const firstDraftId = await createTestDraft({
    prospectId,
    subject: "First draft",
    gmailDraftId: "TEST_EXACT_DRAFT_FIRST",
  });

  const secondDraftId = await createTestDraft({
    prospectId,
    subject: "Second draft",
    gmailDraftId: "TEST_EXACT_DRAFT_SECOND",
  });

  const firstDraft = await getMessageDraftById(firstDraftId);
  assert.ok(firstDraft);
  assert.equal(firstDraft.id, firstDraftId);
  assert.notEqual(firstDraft.id, secondDraftId);
  assert.equal(firstDraft.subject, "First draft");
  assert.equal(firstDraft.gmail_draft_id, "TEST_EXACT_DRAFT_FIRST");
});

after(async () => {
  if (testProspectId) {
    await db.query(
      `
        DELETE FROM prospects
        WHERE id = $1;
      `,
      [testProspectId],
    );
  }

  await db.end();
});
