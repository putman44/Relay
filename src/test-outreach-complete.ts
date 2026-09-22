// src/test-outreach-complete.ts
import { db } from "./db.js";
import { completeOutreachSend } from "./outreach-send.js";
import { getProspectById } from "./prospects.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const draftId = "feb1e8e5-b104-4a4b-aa03-3ca3e2c7b9b3";

async function main() {
  const result = await completeOutreachSend(
    prospectId,
    draftId,
    "TEST_SENT_MESSAGE_ID",
    "TEST_GMAIL_THREAD_ID",
  );

  console.log("Completion result:");
  console.log(result);

  const prospect = await getProspectById(prospectId);

  console.log("\nProspect after completion:");
  console.log(prospect);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
