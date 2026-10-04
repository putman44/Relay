// src/outreach-worker-empty.test.ts

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { db } from "../../src/db.js";
import type { OutreachJob } from "../../src/outreach-jobs.js";
import { runOutreachWorkerOnce } from "../../src/outreach-worker.js";

test("Outreach worker empty queue: returns null without processing a job", async () => {
  let processCallCount = 0;

  const processJob = async (_job: OutreachJob): Promise<void> => {
    processCallCount += 1;
  };

  const result = await runOutreachWorkerOnce(processJob);
  assert.equal(result, null);
  assert.equal(processCallCount, 0);
});
after(async () => {
  await db.end();
});
