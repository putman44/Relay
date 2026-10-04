// scripts/get-outreach-context.ts
import { db } from "../src/db.js";
import { getLatestOutreachDraft } from "../src/outreach/message-drafts.js";
import { getProspectById } from "../src/outreach/prospects.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";

async function main() {
  const prospect = await getProspectById(prospectId);
  const draft = await getLatestOutreachDraft(prospectId);

  console.log({
    prospect,
    draft,
  });

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
