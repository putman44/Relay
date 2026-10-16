import { validateOutreachDraftContent, type OutreachDraftContent } from "../outreach/outreach-draft-content.js";

export const parseOutreachDraftInput = (value: unknown): OutreachDraftContent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Draft input must be a JSON object.");
  }
  const keys = ["requestId", "prospectId", "recipientEmail", "subject", "body"] as const;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key as typeof keys[number]))
    || keys.some((key) => typeof record[key] !== "string")) {
    throw new Error("Draft input must contain only requestId, prospectId, recipientEmail, subject, and body strings.");
  }
  const input = record as OutreachDraftContent;
  validateOutreachDraftContent(input);
  return input;
};

export const parseOutreachDraftArgs = (args: string[]): string => {
  if (args.length !== 3 || args[0] !== "--input" || !args[1]
    || args[1].startsWith("--") || args[2] !== "--confirm-create-draft") {
    throw new Error("Usage: --input <json-file> --confirm-create-draft");
  }
  return args[1];
};
