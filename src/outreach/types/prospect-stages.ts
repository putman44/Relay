// src/outreach/types/prospect-stages.ts

export const PROSPECT_STAGES = [
  "researching",
  "research_in_progress",
  "needs_contact",
  "research_review",
  "draft_ready",
  "outreach_sent",
  "send_reconciliation",
  "replied",
] as const;

export type ProspectStage = (typeof PROSPECT_STAGES)[number];
