// tests/operator/outreach-operator-inspect-missing-job.test.ts
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { db } from "../../src/db.js";
import { inspectOutreachJob } from "../../src/operator/outreach-operator-inspect.js";

after(async () => {
  await db.end();
});

test("Outreach operator inspect: returns null when job does not exist", async () => {
  const result = await inspectOutreachJob(randomUUID());

  assert.equal(result, null);
});
