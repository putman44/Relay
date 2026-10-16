// src/operator/outreach-operations.ts
import { db } from "../db.js";

export type OutreachOperationalAlertCode =
  | "failed_jobs"
  | "stale_processing_jobs"
  | "overdue_ready_jobs"
  | "drafts_need_reconciliation"
  | "prospects_need_reconciliation";

export type OutreachOperationalAlert = {
  code: OutreachOperationalAlertCode;
  count: number;
};

export type OutreachOperationalStatus = {
  checkedAt: Date;
  healthy: boolean;
  thresholds: {
    staleProcessingMinutes: number;
    readyPendingMinutes: number;
  };
  counts: {
    pendingJobs: number;
    readyPendingJobs: number;
    delayedPendingJobs: number;
    processingJobs: number;
    completedJobs: number;
    failedJobs: number;
    staleProcessingJobs: number;
    overdueReadyJobs: number;
    draftsNeedingReconciliation: number;
    prospectsNeedingReconciliation: number;
  };
  oldestReadyPendingAt: Date | null;
  oldestProcessingClaimedAt: Date | null;
  alerts: OutreachOperationalAlert[];
};

export type GetOutreachOperationalStatusOptions = {
  now?: Date;
  staleProcessingMinutes?: number;
  readyPendingMinutes?: number;
};

type JobStatusRow = {
  pending_jobs: string;
  ready_pending_jobs: string;
  delayed_pending_jobs: string;
  processing_jobs: string;
  completed_jobs: string;
  failed_jobs: string;
  stale_processing_jobs: string;
  overdue_ready_jobs: string;
  oldest_ready_pending_at: Date | null;
  oldest_processing_claimed_at: Date | null;
};

type ReconciliationStatusRow = {
  drafts_needing_reconciliation: string;
  prospects_needing_reconciliation: string;
};

const DEFAULT_STALE_PROCESSING_MINUTES = 15;
const DEFAULT_READY_PENDING_MINUTES = 30;

const requirePositiveMinutes = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
};

export const getOutreachOperationalStatus = async ({
  now = new Date(),
  staleProcessingMinutes = DEFAULT_STALE_PROCESSING_MINUTES,
  readyPendingMinutes = DEFAULT_READY_PENDING_MINUTES,
}: GetOutreachOperationalStatusOptions = {}): Promise<OutreachOperationalStatus> => {
  requirePositiveMinutes(
    staleProcessingMinutes,
    "staleProcessingMinutes",
  );
  requirePositiveMinutes(readyPendingMinutes, "readyPendingMinutes");

  const staleBefore = new Date(
    now.getTime() - staleProcessingMinutes * 60_000,
  );
  const overdueReadyBefore = new Date(
    now.getTime() - readyPendingMinutes * 60_000,
  );

  const [jobResult, reconciliationResult] = await Promise.all([
    db.query<JobStatusRow>(
      `
        SELECT
          count(*) FILTER (WHERE status = 'pending')::text AS pending_jobs,
          count(*) FILTER (
            WHERE status = 'pending'
              AND available_at <= $1
          )::text AS ready_pending_jobs,
          count(*) FILTER (
            WHERE status = 'pending'
              AND available_at > $1
          )::text AS delayed_pending_jobs,
          count(*) FILTER (WHERE status = 'processing')::text AS processing_jobs,
          count(*) FILTER (WHERE status = 'completed')::text AS completed_jobs,
          count(*) FILTER (WHERE status = 'failed')::text AS failed_jobs,
          count(*) FILTER (
            WHERE status = 'processing'
              AND claimed_at IS NOT NULL
              AND claimed_at < $2
          )::text AS stale_processing_jobs,
          count(*) FILTER (
            WHERE status = 'pending'
              AND available_at <= $3
          )::text AS overdue_ready_jobs,
          min(available_at) FILTER (
            WHERE status = 'pending'
              AND available_at <= $1
          ) AS oldest_ready_pending_at,
          min(claimed_at) FILTER (
            WHERE status = 'processing'
              AND claimed_at IS NOT NULL
          ) AS oldest_processing_claimed_at
        FROM outreach_jobs;
      `,
      [now, staleBefore, overdueReadyBefore],
    ),
    db.query<ReconciliationStatusRow>(
      `
        SELECT
          (
            SELECT count(*)
            FROM message_drafts
            WHERE draft_type = 'outreach'
              AND send_status = 'needs_reconciliation'
          )::text AS drafts_needing_reconciliation,
          (
            SELECT count(*)
            FROM prospects
            WHERE stage = 'send_reconciliation'
          )::text AS prospects_needing_reconciliation;
      `,
    ),
  ]);

  const jobStatus = jobResult.rows[0];
  const reconciliationStatus = reconciliationResult.rows[0];

  if (!jobStatus || !reconciliationStatus) {
    throw new Error("Failed to read outreach operational status");
  }

  const counts = {
    pendingJobs: Number(jobStatus.pending_jobs),
    readyPendingJobs: Number(jobStatus.ready_pending_jobs),
    delayedPendingJobs: Number(jobStatus.delayed_pending_jobs),
    processingJobs: Number(jobStatus.processing_jobs),
    completedJobs: Number(jobStatus.completed_jobs),
    failedJobs: Number(jobStatus.failed_jobs),
    staleProcessingJobs: Number(jobStatus.stale_processing_jobs),
    overdueReadyJobs: Number(jobStatus.overdue_ready_jobs),
    draftsNeedingReconciliation: Number(
      reconciliationStatus.drafts_needing_reconciliation,
    ),
    prospectsNeedingReconciliation: Number(
      reconciliationStatus.prospects_needing_reconciliation,
    ),
  };

  const alerts: OutreachOperationalAlert[] = [];

  if (counts.failedJobs > 0) {
    alerts.push({ code: "failed_jobs", count: counts.failedJobs });
  }

  if (counts.staleProcessingJobs > 0) {
    alerts.push({
      code: "stale_processing_jobs",
      count: counts.staleProcessingJobs,
    });
  }

  if (counts.overdueReadyJobs > 0) {
    alerts.push({
      code: "overdue_ready_jobs",
      count: counts.overdueReadyJobs,
    });
  }

  if (counts.draftsNeedingReconciliation > 0) {
    alerts.push({
      code: "drafts_need_reconciliation",
      count: counts.draftsNeedingReconciliation,
    });
  }

  if (counts.prospectsNeedingReconciliation > 0) {
    alerts.push({
      code: "prospects_need_reconciliation",
      count: counts.prospectsNeedingReconciliation,
    });
  }

  return {
    checkedAt: now,
    healthy: alerts.length === 0,
    thresholds: {
      staleProcessingMinutes,
      readyPendingMinutes,
    },
    counts,
    oldestReadyPendingAt: jobStatus.oldest_ready_pending_at,
    oldestProcessingClaimedAt: jobStatus.oldest_processing_claimed_at,
    alerts,
  };
};
