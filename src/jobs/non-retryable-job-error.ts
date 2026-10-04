// src/jobs/non-retryable-job-error.ts
export class NonRetryableOutreachJobError extends Error {
  constructor(message: string) {
    super(message);

    this.name = "NonRetryableOutreachJobError";
  }
}
