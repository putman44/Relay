import "dotenv/config";
import { Pool } from "pg";
import { createProspectFromIntake } from "../src/intake/prospect-intake.js";
import { DEMO_DATABASE_NAME, requireDemoDatabaseUrl } from "../src/data/demo-database.js";
import { listDashboardProspects, listIndexedProspects } from "../src/data/research-embeddings.js";
import { askRelay } from "../src/research/ask-relay.js";
import { createOpenAIAnswerer } from "../src/research/openai-answerer.js";
import { createOpenAIEmbedder } from "../src/research/openai-embeddings.js";
import { INTAKE_UI_HOST, parseIntakeUiPort, startIntakeServer } from "../src/web/intake-server.js";
import { createAskRelayHandler } from "../src/web/ask-relay-server.js";
import { DASHBOARD_CSP, renderDashboard } from "../src/web/prospect-dashboard.js";

async function main(): Promise<void> {
  const connectionString = requireDemoDatabaseUrl(process.env.DATABASE_URL);
  const port = parseIntakeUiPort(process.env.RELAY_INTAKE_UI_PORT);
  const pool = new Pool({ connectionString });
  pool.on("error", (error) => console.error("Demo database pool error:", error.name));
  try {
    const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== DEMO_DATABASE_NAME) throw new Error("Unexpected database identity.");
    const server = await startIntakeServer({
      port,
      createProspect: (input) => createProspectFromIntake(input, pool),
      dashboard: {
        listProspects: () => listDashboardProspects(pool),
        render: renderDashboard,
        csp: DASHBOARD_CSP,
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
    console.log(`Relay prospect dashboard at http://${INTAKE_UI_HOST}:${port}/ using local ${DEMO_DATABASE_NAME}.`);
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

main().catch(() => {
  console.error("Relay prospect dashboard failed to start. Check the local demo database and port.");
  process.exitCode = 1;
});
