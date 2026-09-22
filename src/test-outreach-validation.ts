// src/test-outreach-validation.ts
import { db } from "./db.js";
import { getLatestOutreachDraft } from "./message-drafts.js";
import { validateOutreachSend } from "./outreach-validation.js";
import { getProspectById } from "./prospects.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";

async function main() {
  const prospect = await getProspectById(prospectId);
  const draft = await getLatestOutreachDraft(prospectId);

  if (!prospect) {
    throw new Error("Prospect not found.");
  }

  if (!draft) {
    throw new Error("Outreach draft not found.");
  }

  const validation = validateOutreachSend(prospect, draft);

  console.log(validation);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
