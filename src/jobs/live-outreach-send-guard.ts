// src/jobs/live-outreach-send-guard.ts

export type LiveOutreachEnvironment = {
  RELAY_ENABLE_LIVE_OUTREACH_SEND?: string;
};

export function assertLiveOutreachSendEnabled(
  environment: LiveOutreachEnvironment = process.env,
): void {
  if (environment.RELAY_ENABLE_LIVE_OUTREACH_SEND !== "true") {
    throw new Error(
      "Live outreach sending is disabled. Set RELAY_ENABLE_LIVE_OUTREACH_SEND=true to enable it.",
    );
  }
}
