// src/draft-types.ts

export const DRAFT_TYPES = ["outreach", "follow_up", "response"] as const;

export type DraftType = (typeof DRAFT_TYPES)[number];
