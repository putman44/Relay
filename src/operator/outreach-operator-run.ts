// src/operator/outreach-operator-run.ts
import { parseOutreachOperatorArgs } from "./outreach-operator-args.js";
import type { OutreachJobInspection } from "./outreach-operator-inspect.js";

export type OutreachOperatorDependencies = {
  inspectJob: (jobId: string) => Promise<OutreachJobInspection | null>;

  inspectQueue: () => Promise<OutreachJobInspection[]>;
};

export type OutreachOperatorOutput = (
  value: OutreachJobInspection | OutreachJobInspection[],
) => void;

export const runOutreachOperator = async (
  args: string[],
  dependencies: OutreachOperatorDependencies,
  output: OutreachOperatorOutput,
): Promise<void> => {
  const command = parseOutreachOperatorArgs(args);

  if (command.command === "inspect") {
    if (command.jobId) {
      const inspection = await dependencies.inspectJob(command.jobId);

      if (!inspection) {
        throw new Error(`Outreach job not found: ${command.jobId}`);
      }

      output(inspection);
      return;
    }

    const queue = await dependencies.inspectQueue();
    output(queue);
    return;
  }

  throw new Error("Reconciliation execution not implemented");
};
