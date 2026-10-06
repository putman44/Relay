// src/operator/outreach-operator-args.ts
export type OutreachOperatorCommand =
  | {
      command: "inspect";
      jobId: string | null;
    }
  | {
      command: "reconcile-not-sent";
      jobId: string;
      confirmNotSent: true;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const parseOutreachOperatorArgs = (
  args: string[],
): OutreachOperatorCommand => {
  const [command, flag, value] = args;

  if (command === "inspect") {
    if (flag === "--job") {
      if (!value || value.startsWith("--")) {
        throw new Error("Missing job ID after --job");
      }

      return {
        command: "inspect",
        jobId: value,
      };
    }

    if (flag) {
      throw new Error(`Unknown inspect option: ${flag}`);
    }

    return {
      command: "inspect",
      jobId: null,
    };
  }

  if (command === "reconcile-not-sent") {
    if (!args.includes("--confirm-not-sent")) {
      throw new Error("Missing required --confirm-not-sent");
    }

    if (flag !== "--job") {
      throw new Error("Missing required --job");
    }

    if (!value || value.startsWith("--")) {
      throw new Error("Missing job ID after --job");
    }

    if (!isUuid(value)) {
      throw new Error("Invalid job ID: expected UUID");
    }

    return {
      command: "reconcile-not-sent",
      jobId: value,
      confirmNotSent: true,
    };
  }

  throw new Error(`Unknown outreach operator command: ${command ?? ""}`);
};
