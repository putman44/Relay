// Seeds the Ask Relay demo database from saved Firecrawl captures in
// evals/fixtures/ (local and Git-ignored). No Firecrawl or OpenAI calls.
//
//   seed       create demo prospects and save their captured pages
//   id SITE    print the fixed demo prospect UUID for SITE
//
// Seeding refuses any database except a loopback database named relay_demo,
// and every demo prospect is created with cold outreach blocked.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { saveResearchPages } from "../src/data/save-research-pages.js";
import type { ResearchPage } from "../src/research/research-evidence.js";

const DEMO_SITES: Record<
  string,
  { prospectId: string; requestId: string; industry: string }
> = {
  hvac: {
    prospectId: "00000000-0000-4000-a000-000000000001",
    requestId: "00000000-0000-4000-b000-000000000001",
    industry: "HVAC and plumbing",
  },
  counseling: {
    prospectId: "00000000-0000-4000-a000-000000000002",
    requestId: "00000000-0000-4000-b000-000000000002",
    industry: "Counseling",
  },
  relay: {
    prospectId: "00000000-0000-4000-a000-000000000003",
    requestId: "00000000-0000-4000-b000-000000000003",
    industry: "Software",
  },
};

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function requireDemoDatabase(value: string | undefined): string {
  let url: URL, client: Client;
  try {
    url = new URL(value ?? "");
    client = new Client({ connectionString: value });
  } catch {
    throw new Error("DATABASE_URL must be the local relay_demo database.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    decodeURIComponent(url.pathname) !== "/relay_demo" ||
    !localHosts.has(client.host) ||
    client.database !== "relay_demo"
  )
    throw new Error(
      "Demo seeding only writes to a loopback database named relay_demo.",
    );
  return value!;
}

async function seedSite(site: string, pool: Pool) {
  const demo = DEMO_SITES[site]!;
  const file = `evals/fixtures/${site}-page.json`;
  let page: ResearchPage;
  try {
    page = JSON.parse(await readFile(file, "utf8")) as ResearchPage;
  } catch {
    throw new Error(`Missing local capture ${file}.`);
  }
  const url = new URL(page.url);
  const companyName = `Demo: ${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO prospects
      (id, company_name, website, industry, stage, cold_outreach_blocked)
      VALUES ($1,$2,$3,$4,'research_review',true) ON CONFLICT (id) DO NOTHING`,
      [demo.prospectId, companyName, page.url, demo.industry],
    );
    const prospect = await client.query(
      "SELECT 1 FROM prospects WHERE id = $1 AND website = $2",
      [demo.prospectId, page.url],
    );
    await client.query(
      `INSERT INTO prospect_research_requests
      (id, prospect_id, status, owner_token, input_snapshot, drive_parent_id, evidence)
      VALUES ($1,$2,'research_review',gen_random_uuid(),$3,'ask_relay_demo',$4)
      ON CONFLICT DO NOTHING`,
      [
        demo.requestId,
        demo.prospectId,
        JSON.stringify({
          company_name: companyName,
          website: page.url,
          industry: demo.industry,
          contact_email: null,
          contact_name: null,
          primary_discovery_question: null,
        }),
        JSON.stringify({ pages: [page], limitations: [] }),
      ],
    );
    const request = await client.query(
      "SELECT 1 FROM prospect_research_requests WHERE id = $1 AND prospect_id = $2",
      [demo.requestId, demo.prospectId],
    );
    if (prospect.rowCount !== 1 || request.rowCount !== 1)
      throw new Error(`Existing demo rows for ${site} conflict with the seed.`);
    // Reuses identical documents and rejects changed evidence.
    const documents = await saveResearchPages(
      {
        prospectId: demo.prospectId,
        researchRequestId: demo.requestId,
        website: page.url,
        evidence: { pages: [page], limitations: [] },
      },
      client,
    );
    await client.query("COMMIT");
    console.log(
      `${site.padEnd(10)} ${demo.prospectId}  ${documents.length} document(s)  ${page.url}`,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const [action, site] = process.argv.slice(2);
  if (action === "id" && site && DEMO_SITES[site]) {
    console.log(DEMO_SITES[site].prospectId);
    return;
  }
  if (action !== "seed" || site !== undefined)
    throw new Error(
      `Use seed, or id SITE where SITE is one of: ${Object.keys(DEMO_SITES).join(", ")}.`,
    );
  const pool = new Pool({
    connectionString: requireDemoDatabase(process.env.DATABASE_URL),
  });
  try {
    for (const name of Object.keys(DEMO_SITES)) await seedSite(name, pool);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `Demo seed stopped: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
});
