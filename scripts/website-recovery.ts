import "dotenv/config";
import { Pool } from "pg";
import { requireDevDatabaseUrl } from "../src/data/dev-database.js";
import { createFirecrawlScraper } from "../src/research/firecrawl-scraper.js";
import { createOpenAIEmbedder } from "../src/research/openai-embeddings.js";
import { approveWebsiteRecovery, isUuid, startApprovedWebsiteRecovery } from "../src/research/website-index.js";

async function main(args: string[]): Promise<void> {
  const [action, prospectId, requestId, ...rest] = args;
  if (!isUuid(prospectId) || !isUuid(requestId))
    throw new Error("Exact prospect and request IDs required.");
  if (process.env.RELAY_DASHBOARD_DATABASE !== "relay_dev")
    throw new Error("Website recovery is restricted to relay_dev.");
  const connectionString = requireDevDatabaseUrl(process.env.DATABASE_URL);
  if (action === "approve") {
    const [operatorId, basis, confirmation] = rest;
    if (rest.length !== 3 || confirmation !== "APPROVE_ONE_REPLACEMENT")
      throw new Error("Explicit reconciliation approval required.");
    const database = new Pool({ connectionString });
    try {
      const replacementId = await approveWebsiteRecovery({ prospectId: prospectId!, originalRequestId: requestId!, operatorId: operatorId!, basis: basis! }, database);
      console.log(`Approved replacement attempt ${replacementId}. No provider call was made.`);
    } finally { await database.end(); }
    return;
  }
  if (action === "start") {
    if (rest.length !== 1 || rest[0] !== "START_ONE_PAID_COLLECTION")
      throw new Error("Explicit paid collection confirmation required.");
    // Construct providers only after the exact confirmation and database identity check.
    const scrape = createFirecrawlScraper();
    const embed = createOpenAIEmbedder();
    const database = new Pool({ connectionString });
    try {
      await startApprovedWebsiteRecovery(prospectId!, requestId!, { database, scrape, embed });
      console.log(`Replacement attempt ${requestId} indexed successfully.`);
    } finally { await database.end(); }
    return;
  }
  throw new Error("Use approve or start.");
}

main(process.argv.slice(2)).catch(() => {
  console.error("Website recovery stopped; inspect the durable attempt before any further action.");
  process.exitCode = 1;
});
