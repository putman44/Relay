// src/outreach-worker-empty-logging.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import { type OutreachJob } from "../../src/outreach-jobs.js";
import {
  runOutreachWorkerOnce,
  type OutreachWorkerEvent,
} from "../../src/outreach-worker.js";

test("Outreach worker logging: records an empty queue event when no job is available", async () => {
  const processJob = async (_job: OutreachJob): Promise<void> => {};

  const events: OutreachWorkerEvent[] = [];

  const logger = (event: OutreachWorkerEvent): void => {
    events.push(event);
  };

  const result = await runOutreachWorkerOnce(processJob, logger);
  assert.equal(result, null);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "empty",
  });
});

after(async () => {
  await db.end();
});
