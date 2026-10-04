import { db } from "../src/db.js";
import { listProspects } from "../src/outreach/prospects.js";

async function main() {
  const prospects = await listProspects();

  console.table(prospects);

  await db.end();
}

main().catch(async (error) => {
  console.error(error);
  await db.end();
  process.exit(1);
});
