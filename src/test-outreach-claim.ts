// src/test-outreach-claim.ts
import { db } from "./db.js";
import { claimOutreachSend } from "./outreach-send.js";

const prospectId = "03336ca4-c95a-406f-96a3-066fad35e107";
const draftId = "feb1e8e5-b104-4a4b-aa03-3ca3e2c7b9b3";

async function main() {
  console.log("First claim:");

  const first = await claimOutreachSend(prospectId, draftId);

  console.log(first);

  console.log("\nSecond claim:");

  const second = await claimOutreachSend(prospectId, draftId);

  console.log(second);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
