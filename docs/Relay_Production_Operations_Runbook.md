# Relay Production Operations Runbook

**Scope:** Prospect intake, research execution, outreach queue monitoring, scheduled execution, alert response, and safe recovery.

**Default posture:** Monitoring is read-only. Live outreach sending remains disabled unless an operator explicitly enables it for an approved production run.

---

## 1. Non-Negotiable Safety Rules

- Never infer that a thrown Gmail request means the message was not sent.
- Never requeue an uncertain Gmail outcome until a human verifies that Gmail did not send it.
- Reuse the existing failed job during recovery; do not create a replacement job or erase its audit history.
- Keep `RELAY_ENABLE_LIVE_OUTREACH_SEND` unset or set to anything other than `true` while validating monitoring and scheduling.
- Do not start the worker merely to test the monitor. The monitor only reads Postgres.
- Use exact job, draft, and prospect IDs for operator mutations.
- Treat `start`, `start-safe`, `resume`, and `retry-pre-artifact` as provider-using
  research mutations, not read-only status checks.
- Permit research Gmail draft creation only when the durable request stores
  `gmail_draft_allowed = true`; never infer permission from the command currently
  being run or from available Gmail credentials.

---

## 2. Prospect Intake and Research

Apply migrations 012 and 013 through the reviewed migration process before using
the completed intake and stored-policy paths. Migration 012 creates the durable
prospect intake journal. Migration 013 adds
`gmail_draft_allowed BOOLEAN NOT NULL DEFAULT false`, so existing and defaulted
research rows are conservatively Gmail-disabled.

### Intake

```bash
npm run prospect:add -- --input /absolute/path/to/private-prospect.json --confirm-create-prospect
```

Successful identical submissions converge on one prospect and one durable
journal row. The result returns the authoritative persisted journal request ID,
which may differ from a duplicate caller's proposed request ID. A request-ID or
identity conflict with different input fails closed and requires inspection; do
not change the ID or input merely to bypass the conflict.

### Operator intake UI

```bash
npm run intake:ui
```

The intake UI is an internal operator tool, not a public form, and has no
authentication. It listens only on `127.0.0.1` (port `RELAY_INTAKE_UI_PORT`,
default `4310`) and serves a form, a review step, and an explicit confirmation
that creates the prospect through the same intake path as `prospect:add`, with
the same idempotency, duplicate, and conflict behavior. It writes the database
configured by `DATABASE_URL`; verify that target before starting it. It does not
call Firecrawl, OpenAI, Drive, or Gmail and does not start research.

- The server generates each intake request ID and carries it through review and
  confirmation.
- A conflict page means nothing was created or changed. Inspect the intake; do
  not change the request ID or input to get past it.
- An "outcome unknown" page means Relay could not confirm the result. Return to
  the review page and confirm again unchanged with the same request ID; if that
  also fails, stop and inspect that request ID.
- Do not expose the port beyond loopback through proxies, tunnels, or port
  forwarding.

### Research commands and policy

```bash
npm run research -- status --prospect PROSPECT_UUID
npm run research -- start --prospect PROSPECT_UUID --confirm-research
npm run research -- start-safe --prospect PROSPECT_UUID --confirm-research-only
npm run research -- resume --request REQUEST_UUID --confirm-resume
npm run research -- retry-pre-artifact --request REQUEST_UUID --confirm-retry-pre-artifact
```

- `status` reads the durable request and prints identifiers and state without
  exposing research content.
- `start` explicitly persists `gmail_draft_allowed = true`. For an eligible A/B
  result with a public contact, it may create the review-only Gmail draft after
  research and Drive artifacts succeed.
- `start-safe` explicitly persists `gmail_draft_allowed = false`. Research and
  Drive artifact creation continue, but the request finishes in
  `research_review` without calling Gmail or creating a `message_drafts` row.
- `resume` continues only from an allowed durable checkpoint and uses the stored
  Gmail policy. It does not upgrade a safe request because Gmail dependencies or
  credentials are now available.
- `retry-pre-artifact` reuses the same failed request only when its guarded
  pre-artifact conditions pass. It also uses the stored Gmail policy and cannot
  convert a safe request into a Gmail-enabled request.

Only the literal stored value `true` permits Gmail draft creation. Do not edit
that value as an operational shortcut. Inspect `*_creating`,
`needs_reconciliation`, or changed-input requests instead of retrying them.

Local and automated verification uses fake Firecrawl, OpenAI, Drive, and Gmail
providers plus disposable local Postgres. Those results establish application
behavior without authorizing or proving live operation. The mutation commands
above use configured providers: run them against live or production systems only
as a separately approved operation with the intended database, scopes, Drive
parent, prospect/request ID, and stored Gmail policy verified first.

---

## 3. Read-Only Health Check

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

## 4. Inspection and Recovery

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

## 5. Scheduler Contract

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

## 6. Deployment Checklist

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

## 7. Disable and Roll Back

If behavior is unexpected:

1. Disable the worker schedule.
2. Unset `RELAY_ENABLE_LIVE_OUTREACH_SEND`.
3. Leave the read-only monitor running if its database access is trustworthy.
4. Preserve logs and database state.
5. Do not reset processing, failed, or reconciliation records until the Gmail outcome is known.
6. Inspect the exact job and follow the guarded recovery path only after verified-not-sent confirmation.

Stopping the scheduler does not undo a Gmail side effect. Database state and Gmail evidence must be reconciled before resuming.
