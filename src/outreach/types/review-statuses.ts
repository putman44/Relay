// src/outreach/types/review-statuses.ts

export const REVIEW_STATUSES = [
  "needs_review",
  "approved",
  "needs_edit",
  "rejected",
  "sent",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
