// src/send-statuses.ts
export const SEND_STATUSES = [
  "pending",
  "sending",
  "sent",
  "needs_reconciliation",
] as const;

export type SendStatus = (typeof SEND_STATUSES)[number];
