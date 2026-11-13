// Ask Relay demo UI. Connects only to the local relay_demo database; start it
// with `scripts/ask-relay-demo.sh ui`, which pins DATABASE_URL to the demo
// container. Any other database, including the one in .env, is refused.
import "dotenv/config";
import type { Server } from "node:http";
import { Pool } from "pg";
import {
  DEMO_DATABASE_NAME,
  DemoDatabaseError,
  requireDemoDatabaseUrl,
} from "../src/data/demo-database.js";
import { listIndexedProspects } from "../src/data/research-embeddings.js";
import { askRelay, type CitationFailure } from "../src/research/ask-relay.js";
import { createOpenAIAnswerer } from "../src/research/openai-answerer.js";
import { createOpenAIEmbedder } from "../src/research/openai-embeddings.js";
import {
  ASK_UI_HOST,
  parseAskUiPort,
  startAskRelayServer,
} from "../src/web/ask-relay-server.js";

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "ask-relay-ui", ...record }));
}

function citationDiagnosticLogger(
  enabled: boolean,
  logger: typeof log,
): ((failure: CitationFailure) => void) | undefined {
  return enabled
    ? (failure) => logger({ event: "citation_verification_failed", ...failure })
    : undefined;
}

async function main(): Promise<void> {
  // Checked before anything connects.
  const connectionString = requireDemoDatabaseUrl(process.env.DATABASE_URL);
  const port = parseAskUiPort(process.env.RELAY_ASK_UI_PORT);
  const embed = createOpenAIEmbedder();
  const answer = createOpenAIAnswerer();

  const pool = new Pool({ connectionString });
  // An idle client error must not crash the process; requests fail on their own.
  pool.on("error", (error) =>
    log({
      event: "database_pool_error",
      error: error.name,
      code: (error as { code?: unknown }).code,
    }),
  );
  let server: Server;
  try {
    const identity = await pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (identity.rows[0]?.name !== DEMO_DATABASE_NAME)
      throw new DemoDatabaseError();
    server = await startAskRelayServer({
      port,
      listProspects: () => listIndexedProspects(pool),
      ask: (input) => askRelay(input, {
        database: pool,
        embed,
        answer,
        onCitationFailure: citationDiagnosticLogger(
          process.env.RELAY_ASK_CITATION_DIAGNOSTICS === "true",
          log,
        ),
      }),
      log,
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  console.log(
    `Ask Relay demo UI listening on http://${ASK_UI_HOST}:${port}/ (loopback only).`,
  );
  console.log(
    `Reading the local ${DEMO_DATABASE_NAME} database only. Each question calls OpenAI. Press Ctrl+C to stop.`,
  );

  // A second signal falls through to Node's default handler and exits immediately.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping Ask Relay demo UI.");
    server.close(() => {
      pool.end().catch(() => {
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof DemoDatabaseError
      ? `Ask Relay UI did not start. ${error.message} Start it with: scripts/ask-relay-demo.sh ui`
      : "Ask Relay UI failed to start. Check that the demo database is running " +
          "(scripts/ask-relay-demo.sh up), OPENAI_API_KEY and RELAY_RESEARCH_MODEL are set, " +
          "and the port is free.",
  );
  process.exitCode = 1;
});
