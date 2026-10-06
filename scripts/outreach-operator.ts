// scripts/outreach-operator.ts
import "dotenv/config";

import { db } from "../src/db.js";
import { reconcileAndRequeueOutreachJobAsNotSent } from "../src/jobs/outreach-reconciliation.js";
import {
  inspectOutreachJob,
  inspectOutreachQueue,
} from "../src/operator/outreach-operator-inspect.js";
import { runOutreachOperator } from "../src/operator/outreach-operator-run.js";

const main = async (): Promise<void> => {
  await runOutreachOperator(
    process.argv.slice(2),
    {
      inspectJob: inspectOutreachJob,
      inspectQueue: inspectOutreachQueue,
      reconcileNotSent: reconcileAndRequeueOutreachJobAsNotSent,
    },
    (value) => {
      if (Array.isArray(value)) {
        console.table(value);
        return;
      }

      console.table([value]);
    },
  );
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);

    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
