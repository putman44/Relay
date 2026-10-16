// src/operator/outreach-monitor.ts
import {
  getOutreachOperationalStatus,
  type GetOutreachOperationalStatusOptions,
  type OutreachOperationalStatus,
} from "./outreach-operations.js";

export type OutreachMonitorEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type OutreachMonitorSnapshot = OutreachOperationalStatus & {
  service: "outreach-monitor";
};

export type OutreachMonitorDependencies = {
  env?: OutreachMonitorEnvironment;
  getStatus?: (
    options: GetOutreachOperationalStatusOptions,
  ) => Promise<OutreachOperationalStatus>;
  write?: (line: string) => void;
};

const parsePositiveInteger = (
  name: string,
  value: string | undefined,
  fallback: number,
): number => {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
};

export const runOutreachMonitor = async ({
  env = process.env,
  getStatus = getOutreachOperationalStatus,
  write = console.log,
}: OutreachMonitorDependencies = {}): Promise<0 | 2> => {
  const staleProcessingMinutes = parsePositiveInteger(
    "RELAY_STALE_PROCESSING_MINUTES",
    env.RELAY_STALE_PROCESSING_MINUTES,
    15,
  );
  const readyPendingMinutes = parsePositiveInteger(
    "RELAY_READY_PENDING_ALERT_MINUTES",
    env.RELAY_READY_PENDING_ALERT_MINUTES,
    30,
  );

  const status = await getStatus({
    staleProcessingMinutes,
    readyPendingMinutes,
  });
  const snapshot: OutreachMonitorSnapshot = {
    service: "outreach-monitor",
    ...status,
  };

  write(JSON.stringify(snapshot, null, 2));

  return status.healthy ? 0 : 2;
};
