// src/jobs/job-statuses.ts
export const JOB_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];