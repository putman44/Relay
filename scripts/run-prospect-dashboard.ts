import "dotenv/config";
import { Pool } from "pg";
import { createProspectFromIntake } from "../src/intake/prospect-intake.js";
import { DEMO_DATABASE_NAME, requireDemoDatabaseUrl } from "../src/data/demo-database.js";
import { DEV_DATABASE_NAME, requireDevDatabaseUrl } from "../src/data/dev-database.js";
import { listAssessments } from "../src/data/lead-assessments.js";
import { listDashboardProspects, listIndexedProspects } from "../src/data/research-embeddings.js";
import { askRelay } from "../src/research/ask-relay.js";
import { createOpenAIAnswerer } from "../src/research/openai-answerer.js";
import { generateLeadIntakeAssessment } from "../src/research/lead-intake-assessment.js";
import { createOpenAIAssessor } from "../src/research/openai-assessor.js";
import { createOpenAIEmbedder } from "../src/research/openai-embeddings.js";
import { INTAKE_UI_HOST, parseIntakeUiPort, startIntakeServer } from "../src/web/intake-server.js";
import { createAskRelayHandler } from "../src/web/ask-relay-server.js";
import { DASHBOARD_CSP, renderDashboard } from "../src/web/prospect-dashboard.js";
import { researchAndIndexWebsite } from "../src/research/website-index.js";
import { createFirecrawlScraper } from "../src/research/firecrawl-scraper.js";

async function main(): Promise<void> {
  const dev = process.env.RELAY_DASHBOARD_DATABASE === DEV_DATABASE_NAME;
  const connectionString = dev
    ? requireDevDatabaseUrl(process.env.DATABASE_URL)
    : requireDemoDatabaseUrl(process.env.DATABASE_URL);
  const databaseName = dev ? DEV_DATABASE_NAME : DEMO_DATABASE_NAME;
  const port = parseIntakeUiPort(process.env.RELAY_INTAKE_UI_PORT);
  const pool = new Pool({ connectionString });
  pool.on("error", (error) => console.error("Demo database pool error:", error.name));
  try {
    const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== databaseName) throw new Error("Unexpected database identity.");
    const server = await startIntakeServer({
      port,
      createProspect: (input) => createProspectFromIntake(input, pool),
      dashboard: {
        listProspects: () => listDashboardProspects(pool),
        render: renderDashboard,
        csp: DASHBOARD_CSP,
        researchIndex: (prospectId) => researchAndIndexWebsite(prospectId, {
          database: pool, scrape: createFirecrawlScraper(), embed: createOpenAIEmbedder(),
        }),
        loadAssessment: (prospectId) => listAssessments(prospectId, pool),
        generateAssessment: (prospectId) => generateLeadIntakeAssessment(prospectId, {
          database: pool, embed: createOpenAIEmbedder(), assess: createOpenAIAssessor(),
          model: process.env.RELAY_RESEARCH_MODEL?.trim() ?? "",
        }),
        askHandler: (getServer) => createAskRelayHandler({
          listProspects: () => listIndexedProspects(pool),
          ask: (input) => askRelay(input, {
            database: pool,
            embed: createOpenAIEmbedder(),
            answer: createOpenAIAnswerer(),
          }),
        }, getServer, { dashboard: true }),
      },
    });
    console.log(`Relay prospect dashboard at http://${INTAKE_UI_HOST}:${port}/ using local ${databaseName}.`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => { pool.end().catch(() => { process.exitCode = 1; }); });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("Relay prospect dashboard failed to start:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
