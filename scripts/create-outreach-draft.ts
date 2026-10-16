import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseOutreachDraftArgs, parseOutreachDraftInput } from "../src/operator/outreach-draft-input.js";

const main = async (): Promise<void> => {
  const file = parseOutreachDraftArgs(process.argv.slice(2));
  const input = parseOutreachDraftInput(JSON.parse(await readFile(file, "utf8")));
  // Parse and require explicit intent before loading DB or Gmail credentials.
  const { db } = await import("../src/db.js");
  try {
    const { createProductionGmailDraftCreator } = await import("../src/gmail/gmail-runtime.js");
    const { createOutreachDraft } = await import("../src/outreach/outreach-draft-creation.js");
    const draft = await createOutreachDraft(input, {
      database: db,
      createGmailDraft: createProductionGmailDraftCreator(),
    });
    console.log(JSON.stringify({
      draftId: draft.id,
      prospectId: draft.prospect_id,
      gmailDraftId: draft.gmail_draft_id,
      reviewStatus: draft.review_status,
    }));
  } finally {
    await db.end();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Outreach draft creation failed.");
  process.exitCode = 1;
});
