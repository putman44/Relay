// src/operator/outreach-operator-args.ts
export type OutreachOperatorCommand =
  | {
      command: "inspect";
      jobId: string | null;
    }
  | {
      command: "review";
      prospectId: string;
    }
  | {
      command: "approve";
      prospectId: string;
      draftId: string;
      confirmApproval: true;
    }
  | {
      command: "queue";
      prospectId: string;
      draftId: string;
      confirmQueue: true;
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
      if (args.length > 3) {
        throw new Error("Unexpected arguments for inspect");
      }

      if (!value || value.startsWith("--")) {
        throw new Error("Missing job ID after --job");
      }

      if (!isUuid(value)) {
        throw new Error("Invalid job ID: expected UUID");
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

  if (command === "review") {
    if (args.length > 3) {
      throw new Error("Unexpected arguments for review");
    }

    if (flag !== "--prospect") {
      throw new Error("Missing required --prospect");
    }

    if (!value || value.startsWith("--")) {
      throw new Error("Missing prospect ID after --prospect");
    }

    if (!isUuid(value)) {
      throw new Error("Invalid prospect ID: expected UUID");
    }

    return {
      command: "review",
      prospectId: value,
    };
  }

  if (command === "approve" || command === "queue") {
    const confirmationFlag =
      command === "approve" ? "--confirm-approval" : "--confirm-queue";

    if (args.length > 6) {
      throw new Error(`Unexpected arguments for ${command}`);
    }

    if (args[5] !== confirmationFlag) {
      throw new Error(`Missing required ${confirmationFlag}`);
    }

    if (flag !== "--prospect") {
      throw new Error("Missing required --prospect");
    }

    if (!value || value.startsWith("--")) {
      throw new Error("Missing prospect ID after --prospect");
    }

    if (!isUuid(value)) {
      throw new Error("Invalid prospect ID: expected UUID");
    }

    if (args[3] !== "--draft") {
      throw new Error("Missing required --draft");
    }

    const draftId = args[4];

    if (!draftId || draftId.startsWith("--")) {
      throw new Error("Missing draft ID after --draft");
    }

    if (!isUuid(draftId)) {
      throw new Error("Invalid draft ID: expected UUID");
    }

    if (command === "approve") {
      return {
        command: "approve",
        prospectId: value,
        draftId,
        confirmApproval: true,
      };
    }

    return {
      command: "queue",
      prospectId: value,
      draftId,
      confirmQueue: true,
    };
  }

  if (command === "reconcile-not-sent") {
    if (args.length > 4) {
      throw new Error("Unexpected arguments for reconcile-not-sent");
    }

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
