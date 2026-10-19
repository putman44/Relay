import "dotenv/config";
import type { Server } from "node:http";
import { createProspectFromIntake } from "../src/intake/prospect-intake.js";
import {
  INTAKE_UI_HOST,
  parseIntakeUiPort,
  startIntakeServer,
} from "../src/web/intake-server.js";

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: "intake-ui", ...record }));
}

async function main(): Promise<void> {
  const port = parseIntakeUiPort(process.env.RELAY_INTAKE_UI_PORT);
  const { db } = await import("../src/db.js");
  // An idle client error must not crash the process; requests already fail closed on their own.
  db.on("error", (error) =>
    log({ event: "database_pool_error", error: error.name, code: (error as { code?: unknown }).code }));

  let server: Server;
  try {
    server = await startIntakeServer({
      port,
      createProspect: (input) => createProspectFromIntake(input, db),
      log,
    });
  } catch (error) {
    await db.end();
    throw error;
  }
  console.log(`Relay intake UI listening on http://${INTAKE_UI_HOST}:${port}/ (loopback only).`);
  console.log("Confirmed prospects are written to the database configured by DATABASE_URL. Press Ctrl+C to stop.");

  // A second signal falls through to Node's default handler and exits immediately.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping Relay intake UI after in-flight requests finish.");
    server.close(() => {
      db.end().catch(() => {
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  console.error("Relay intake UI failed to start.");
  process.exitCode = 1;
});
