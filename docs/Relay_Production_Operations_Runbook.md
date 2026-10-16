# Relay Production Operations Runbook

**Scope:** Outreach queue monitoring, scheduled execution, alert response, and safe recovery.

**Default posture:** Monitoring is read-only. Live outreach sending remains disabled unless an operator explicitly enables it for an approved production run.

---

## 1. Non-Negotiable Safety Rules

- Never infer that a thrown Gmail request means the message was not sent.
- Never requeue an uncertain Gmail outcome until a human verifies that Gmail did not send it.
- Reuse the existing failed job during recovery; do not create a replacement job or erase its audit history.
- Keep `RELAY_ENABLE_LIVE_OUTREACH_SEND` unset or set to anything other than `true` while validating monitoring and scheduling.
- Do not start the worker merely to test the monitor. The monitor only reads Postgres.
- Use exact job, draft, and prospect IDs for operator mutations.

---

## 2. Read-Only Health Check

Run from the Relay project directory:

```bash
npm run monitor:outreach
```

Optional thresholds:

```bash
RELAY_STALE_PROCESSING_MINUTES=15 RELAY_READY_PENDING_ALERT_MINUTES=30 npm run monitor:outreach
```

The command emits one JSON snapshot. It contains aggregate counts and timestamps, not recipient addresses, message bodies, or company names.

### Exit codes

| Code | Meaning | Scheduler action |
| ---: | --- | --- |
| `0` | Healthy; no alert condition found | Record success |
| `2` | Monitor ran successfully and found work requiring attention | Alert the operator and preserve the JSON output |
| `1` | Monitor could not produce a trustworthy snapshot | Alert as a monitoring failure |

Exit code `2` is an operational alert, not a monitor crash.

### Alert conditions

| Alert code | Meaning | First response |
| --- | --- | --- |
| `failed_jobs` | One or more jobs are terminally failed | Inspect the exact job; do not automatically requeue it |
| `stale_processing_jobs` | A processing job has exceeded the stale threshold | Determine whether a worker stopped and whether Gmail may have been invoked |
| `overdue_ready_jobs` | A ready pending job has waited past the threshold | Check scheduler health and whether live sending was intentionally disabled |
| `drafts_need_reconciliation` | A draft has an uncertain Gmail outcome | Verify Gmail manually before any recovery |
| `prospects_need_reconciliation` | A prospect is blocked on send reconciliation | Resolve the matching draft/job evidence as one incident |

---

## 3. Inspection and Recovery

Inspect the non-completed queue:

```bash
npm run outreach:operator -- inspect
```

Inspect one exact job:

```bash
npm run outreach:operator -- inspect --job <job-uuid>
```

For an uncertain send, check Gmail and database evidence before changing state. If the message may have been sent, leave the job failed and the records in reconciliation. If a human has verified that Gmail did not send it, use the guarded atomic recovery command:

```bash
npm run outreach:operator -- reconcile-not-sent --job <job-uuid> --confirm-not-sent
```

That command resolves reconciliation and requeues the same failed job. It preserves `attempt_count` and `last_error` for auditability.

---

## 4. Scheduler Contract

No scheduler is activated by this repository change. When production scheduling is explicitly approved, configure the host scheduler to meet this contract:

### Monitor schedule

- Run the hardened `relay-outreach-monitor:local` container every five minutes.
- Keep Node.js, npm, Gmail credentials, and the worker entrypoint out of the host schedule.
- Load only the production monitor database environment and explicitly override live outreach sending to `false`.
- Capture stdout, stderr, timestamp, and exit code.
- Page or notify on exit `1` or `2`; deduplicate repeated alerts outside Relay.
- Apply a runtime timeout so a hung monitor cannot overlap indefinitely.

### Worker schedule

- Run `npm run worker:outreach` as a one-shot command, no more than once per minute.
- Activate it only after live sending is separately approved and the explicit live-send guard is intentionally enabled.
- Prefer a scheduler lock or non-overlapping job policy. Postgres `FOR UPDATE SKIP LOCKED` protects job claims, but scheduler overlap still adds needless operational ambiguity.
- Capture the structured worker events and exit status.
- Treat reconciliation or terminal failure as operator work, never as permission for a blind retry.

### Platform-neutral scheduler flow

```text
every 5 minutes
  -> run outreach monitor
  -> exit 0: retain normal log
  -> exit 2: notify operator with JSON snapshot
  -> exit 1: notify operator that monitoring itself failed

every 1 minute, only after explicit production activation
  -> acquire non-overlap lock
  -> run one-shot outreach worker
  -> release lock
```

The reviewed Docker image and systemd monitor templates live in `deploy/docker/` and `deploy/systemd/`. They package and schedule only the read-only monitor, run it as a non-root container with a read-only filesystem, and explicitly keep live sending disabled. Do not store production secrets in the image, scheduler definitions, or this repository.

No worker service or timer is included. Worker scheduling remains a separate production change that requires explicit live-send approval.

---

## 5. Deployment Checklist

1. Confirm `npm run typecheck` passes.
2. Confirm `npm test` passes.
3. Build `relay-outreach-monitor:local` from `deploy/docker/relay-monitor.Dockerfile`.
4. Run the hardened container manually and review every nonzero count.
5. Confirm the Docker path, image tag, database reachability, and environment source.
6. Validate the systemd files with `systemd-analyze verify` on the Linux host.
7. Configure the monitor schedule first and verify alert delivery with a controlled non-production test.
8. Keep live outreach disabled while validating the monitor.
9. Review every failed or reconciliation record before worker activation.
10. Obtain explicit approval before enabling the worker schedule or the live-send guard.
11. After activation, verify one job at a time: claim, Gmail result, database finalization, and completion.

---

## 6. Disable and Roll Back

If behavior is unexpected:

1. Disable the worker schedule.
2. Unset `RELAY_ENABLE_LIVE_OUTREACH_SEND`.
3. Leave the read-only monitor running if its database access is trustworthy.
4. Preserve logs and database state.
5. Do not reset processing, failed, or reconciliation records until the Gmail outcome is known.
6. Inspect the exact job and follow the guarded recovery path only after verified-not-sent confirmation.

Stopping the scheduler does not undo a Gmail side effect. Database state and Gmail evidence must be reconciled before resuming.
