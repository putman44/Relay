// src/outreach/types/prospect-stages.ts

export const PROSPECT_STAGES = [
  "researching",
  "draft_ready",
  "outreach_sent",
  "send_reconciliation",
] as const;

export type ProspectStage = (typeof PROSPECT_STAGES)[number];
