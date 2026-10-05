// scripts/run-outreach-worker.ts

import "dotenv/config";

import { assertLiveOutreachSendEnabled } from "../src/jobs/live-outreach-send-guard.js";
import { createProductionOutreachProcessor } from "../src/jobs/outreach-worker-runtime.js";
import {
  runOutreachWorkerOnce,
  type OutreachWorkerEvent,
} from "../src/jobs/outreach-worker.js";

function logWorkerEvent(event: OutreachWorkerEvent): void {
  console.log(
    JSON.stringify({
      service: "outreach-worker",
      ...event,
    }),
  );
}

async function main(): Promise<void> {
  assertLiveOutreachSendEnabled();

  const processJob = createProductionOutreachProcessor();

  const result = await runOutreachWorkerOnce(processJob, logWorkerEvent);

  if (!result) {
    console.log("No outreach job available.");
  }
}

main().catch((error) => {
  console.error("Outreach worker failed to start:", error);
  process.exitCode = 1;
});
