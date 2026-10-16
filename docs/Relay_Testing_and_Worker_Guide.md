# Relay Testing & Worker Guide

**Project:** Relay
**Current test checkpoint:** 136 tests passing, 0 failing (verified October 16, 2026)
**Purpose:** Explain what the tests protect, how the queue/worker system fits together, and what to do when adding new behavior.

---

## 1. Big Picture

Relay now has four major safety layers:

1. **Human review/operator rules** require exact record identities and explicit confirmation for mutations.
2. **Outreach/business rules** protect approved drafts and sending behavior.
3. **Outreach job queue + worker rules** protect background processing, retries, failures, and concurrency.
4. **Gmail side-effect rules** distinguish safe retries from outcomes that require human reconciliation.

```mermaid
flowchart LR
    P[Prospect] --> D[Message Draft]
    D --> J[Outreach Job]
    J --> W[Production Worker]
    W --> PR[processOutreachJob]
    PR --> CL[Claim Exact Approved Draft]
    CL --> G[Gmail Draft Sender]
    G -->|confirmed sent| DB[Database Finalization]
    G -->|thrown or uncertain| RC[Reconciliation Required]
    DB --> C[Completed Job]
    PR -->|retryable failure before Gmail| R[Normal Retry Policy]
    RC --> F[Failed Job: No Automatic Retry]
    W -->|no work| E[Empty]
    J --> S[Stale Detection]
```

The production worker now connects the durable queue to Gmail. That makes the side-effect boundary the most important retry boundary in the system: failures known to occur before Gmail is invoked may use normal retry policy, but outcomes after invocation are never blindly retried.

---

## 2. Key Terms

### Prospect

The business/customer target that Relay is working with.

### Message Draft

The outreach message associated with a prospect. Existing tests protect approval, recipient matching, Gmail draft presence, completion, and reconciliation behavior.

### Outreach Job

A durable Postgres queue record tied to a message draft.

Important fields:

- `status`
- `attempt_count`
- `available_at`
- `claimed_at`
- `last_error`

### Worker

The orchestration layer that:

1. asks Postgres for the next eligible job,
2. processes it,
3. completes it, retries it, or fails it,
4. emits structured events.

The production entry point is `scripts/run-outreach-worker.ts`. It checks the explicit live-send guard before constructing the production processor or claiming work.

### `processJob`

The worker accepts a processing dependency. In production, `createProductionOutreachProcessor()` supplies a processor backed by `processOutreachJob()` and the Gmail draft sender. Tests can still inject controlled processors to prove worker behavior without calling Gmail.

The production path is:

```text
outreach job
-> production worker
-> processOutreachJob
-> claim exact approved draft
-> Gmail draft sender
-> confirmed send OR reconciliation
-> database finalization
-> confirmed send: completed job
-> reconciliation: failed job requiring human review
```

---

## 3. Outreach Job State Machine

```mermaid
stateDiagram-v2
    [*] --> pending: createOutreachJob()

    pending --> processing: claimNextOutreachJob()
    processing --> completed: completeOutreachJob()

    processing --> pending: retryOutreachJob()
    processing --> failed: failOutreachJob()
    failed --> pending: requeueFailedOutreachJob() after verified-not-sent reconciliation

    completed --> [*]

    note right of pending
      Claimable only when:
      available_at <= now()
    end note

    note right of processing
      attempt_count increments
      when a worker claims the job
    end note

    note right of failed
      Terminal for automatic processing.
      Guarded manual requeue only after
      explicit verified-not-sent reconciliation.
    end note
```

### Legal transitions

| From         | To           |           Allowed? | Function                     |
| ------------ | ------------ | -----------------: | ---------------------------- |
| `pending`    | `processing` |                Yes | `claimNextOutreachJob()`     |
| `processing` | `completed`  |                Yes | `completeOutreachJob(jobId)` |
| `processing` | `pending`    |                Yes | `retryOutreachJob(...)`      |
| `processing` | `failed`     |                Yes | `failOutreachJob(...)`       |
| `pending`    | `completed`  |                 No | Guarded                      |
| `pending`    | `failed`     |                 No | Guarded                      |
| `completed`  | `completed`  |                 No | Guarded                      |
| `failed`     | `processing` | No automatic claim | Terminal for automatic work  |
| `failed`     | `pending`    | Guarded manual only | `requeueFailedOutreachJob()`  |

---

## 4. How Claiming Works

The queue chooses the next job. The worker does **not** pass a job ID into the claim function.

```ts
const job = await claimNextOutreachJob();
```

Conceptually:

```mermaid
flowchart TD
    A[Worker asks for next job] --> B{Pending job exists?}
    B -->|No| N[Return null]
    B -->|Yes| C{available_at <= now?}
    C -->|No| N
    C -->|Yes| L[Lock row with FOR UPDATE SKIP LOCKED]
    L --> U[Set status = processing]
    U --> I[Increment attempt_count]
    I --> T[Set claimed_at]
    T --> R[Return claimed job]
```

`FOR UPDATE SKIP LOCKED` protects the queue when multiple workers race at the same time. One worker gets the row; another skips it instead of double-claiming it.

---

## 5. Retry Behavior

Failures known to occur before the Gmail side effect may use the normal retry policy unless they are classified as non-retryable business or state errors. Retryable failures are attempted up to three total times.

Current worker policy:

```text
Attempt 1 fails -> retry
Attempt 2 fails -> retry
Attempt 3 fails -> terminal failed
```

The worker uses:

```text
MAX_ATTEMPTS = 3
RETRY_DELAY_MS = 60,000
```

When a retry is scheduled:

```text
status       -> pending
last_error   -> error message
available_at -> future timestamp
claimed_at   -> null
attempt_count stays unchanged
```

`attempt_count` increases only when a job is actually claimed again.

### Gmail side-effect boundary

The normal retry policy applies to failures that occur before Gmail send has been invoked. Once the Gmail draft sender is called, Relay can no longer assume that a thrown error means nothing happened.

```mermaid
flowchart TD
    A[Processing failure] --> B{Was Gmail send invoked?}
    B -->|No| C[Normal retry policy may apply]
    B -->|Yes| D{Confirmed sent?}
    D -->|Yes| E[Persist Gmail message and thread IDs]
    E --> F[Complete job]
    D -->|No or uncertain| G[Persist reconciliation state]
    G --> H[Fail job as non-retryable]
    H --> I[Require human verification]
```

A thrown Gmail call, an explicit uncertain result, or a database-finalization failure after a confirmed send is non-retryable. This prevents a second automatic Gmail invocation when the first invocation may already have sent the message.

Example:

```mermaid
sequenceDiagram
    participant W as Worker
    participant DB as Postgres
    participant P as processJob

    W->>DB: claim job
    DB-->>W: processing, attempt_count=1
    W->>P: process job
    P-->>W: throws error
    W->>DB: retryOutreachJob()
    DB-->>W: pending, attempt_count=1

    Note over W,DB: available_at becomes eligible later

    W->>DB: claim job again
    DB-->>W: processing, attempt_count=2
```

---

## 6. Terminal Failure and Guarded Manual Requeue

A job becomes automatically terminal `failed` when the worker reaches the maximum attempt count and processing fails again. A `NonRetryableOutreachJobError` also fails the job immediately, even on its first attempt, when retrying could duplicate an external side effect or violate a business guard.

```mermaid
flowchart TD
    A[processJob throws] --> NR{Non-retryable?}
    NR -->|Yes| F[Mark failed]
    NR -->|No| B{attempt_count < 3?}
    B -->|Yes| R[Schedule retry]
    R --> P[status = pending]
    B -->|No| F
    F --> X[No automatic claiming]
    X --> H{Human confirms Gmail did not send?}
    H -->|No or unknown| X
    H -->|Yes| RC[Resolve reconciliation]
    RC --> G{Requeue guards pass?}
    G -->|No| X
    G -->|Yes| Q[Requeue same job as pending]
```

A failed job is not returned by `claimNextOutreachJob()` because the claim query only looks for `status = 'pending'`.

`requeueFailedOutreachJob()` is the only guarded manual path from `failed` back to `pending`. It requires:

- the existing job to be `failed`,
- the draft to be `pending`,
- the draft to remain `approved`,
- the prospect to be `draft_ready`,
- no `sent_message_id`, and
- no `sent_at`.

The function preserves `attempt_count` and preserves `last_error` as audit history. It updates the existing job rather than inserting a replacement.

`outreach_jobs.draft_id` is unique. One draft therefore has one queue job; after verified-not-sent reconciliation, Relay requeues that same failed job instead of creating a second job for the same draft.

### Resolving a confirmed non-send

`resolveOutreachReconciliationAsNotSent(prospectId, draftId)` is a human-authorized recovery operation. It must be used only after a person has confirmed that Gmail did not send the message.

It performs these state transitions in one database transaction:

```text
message_drafts.send_status:
needs_reconciliation -> pending

prospects.stage:
send_reconciliation -> draft_ready
```

It rejects records that are not in both reconciliation states, and it rejects any draft with `sent_message_id` or `sent_at` evidence. It clears the reconciliation error and timestamp but leaves approval intact. After that explicit resolution, `requeueFailedOutreachJob()` may return the existing failed job to `pending` only if all of its own guards also pass.

---

## 7. Stale Job Detection

A worker can crash after claiming a job and leave it stuck in `processing`.

Relay now detects this without automatically retrying it.

```mermaid
flowchart TD
    A[Job is processing] --> B{claimed_at older than cutoff?}
    B -->|No| C[Ignore: still fresh]
    B -->|Yes| D[Return as stale]
    D --> E[Do NOT automatically retry]
```

This separation is deliberate.

A stale job could mean:

```text
Safe-looking case:
worker claimed job -> crashed before doing anything

Dangerous case:
worker claimed job -> external action succeeded -> worker crashed
```

Because Gmail is connected, blindly retrying the second case could send a duplicate message.

So:

**Detect stale jobs: yes.**
**Blindly requeue stale jobs: no.**

---

## 8. Worker Flow

```mermaid
flowchart TD
    A[runOutreachWorkerOnce] --> B[claimNextOutreachJob]
    B --> C{Job found?}

    C -->|No| E[Emit empty event]
    E --> N[Return null]

    C -->|Yes| CL[Emit claimed event]
    CL --> P[processJob(job)]

    P -->|Success| CO[completeOutreachJob]
    CO --> CE[Emit completed event]
    CE --> CR[Return completed job]

    P -->|Throws| NR{Non-retryable?}

    NR -->|Yes| F[failOutreachJob]
    NR -->|No| Q{attempt_count < 3?}

    Q -->|Yes| R[retryOutreachJob]
    R --> RE[Emit retry_scheduled event]
    RE --> RR[Return pending job]

    Q -->|No| F
    F --> FE[Emit failed event]
    FE --> FR[Return failed job]
```

In the production processor, a Gmail call that throws or returns an uncertain outcome is converted into a non-retryable failure after reconciliation state is persisted. The worker therefore marks the job failed on that attempt instead of scheduling another Gmail send.

### Guarded operator review flow

The operator CLI exposes the human-controlled path without starting the worker:

```bash
npm run outreach:operator -- review --prospect <prospect-uuid>

npm run outreach:operator -- approve \
  --prospect <prospect-uuid> \
  --draft <draft-uuid> \
  --confirm-approval

npm run outreach:operator -- queue \
  --prospect <prospect-uuid> \
  --draft <draft-uuid> \
  --confirm-queue
```

`review` is read-only. `approve` changes only an eligible `needs_review` outreach draft to `approved`. `queue` creates one pending job only for the matching approved/pending draft and a `draft_ready` prospect. Approval does not automatically queue, and queueing does not run the worker or call Gmail. Both mutations require their exact confirmation flag.

---

## 9. Worker Event Logging

The worker currently emits structured events instead of relying only on arbitrary `console.log()` statements.

Current event types:

```text
empty
claimed
completed
retry_scheduled
failed
```

Examples:

```ts
{
  type: "claimed",
  jobId: "...",
  attemptCount: 1
}
```

```ts
{
  type: "retry_scheduled",
  jobId: "...",
  attemptCount: 1,
  error: "Temporary processing failure",
  retryAt: ...
}
```

```ts
{
  type: "failed",
  jobId: "...",
  attemptCount: 3,
  error: "Third failure"
}
```

The worker emits state-change events **after** the corresponding database update succeeds. This prevents logging a transition that never actually happened.

---

# 10. Test Catalog

The suite currently contains **136 tests**, with **136 passing and 0 failing** at the verified checkpoint.

## A. Gmail Integration and Outreach Safety Tests

| Test file                                   | Test                                                                                                     | What it protects                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `gmail-api-client.test.ts`                  | Gmail auth: creates Gmail API compatible with draft sender                                               | Production auth wiring supplies the API shape required by the sender.                  |
| `gmail-auth-missing-refresh-token.test.ts`  | Gmail auth: rejects missing refresh token                                                                | Production Gmail setup fails closed when credentials are incomplete.                   |
| `gmail-auth.test.ts`                        | Gmail auth: loads complete OAuth credentials                                                             | Required OAuth configuration is loaded into the runtime boundary.                      |
| `gmail-draft-sender-incomplete-response.test.ts` | Gmail draft sender: rejects an incomplete Gmail response                                            | Missing confirmed message evidence is never treated as a successful send.              |
| `gmail-draft-sender.test.ts`                | Gmail draft sender: sends the exact Gmail draft and returns message IDs                                  | The sender uses the claimed Gmail draft and returns finalization evidence.              |
| `gmail-oauth-client.test.ts`                | Gmail auth: configures OAuth client with refresh token                                                    | OAuth refresh credentials are installed on the Gmail client.                           |
| `gmail-reconciliation.test.ts`              | Gmail reconciliation: marks an uncertain Gmail send for reconciliation                                   | An uncertain send is routed to reconciliation instead of treated as confirmed success. |
| `gmail-runtime.test.ts`                     | Gmail runtime: creates a production draft sender from environment credentials                            | The production processor can construct the real Gmail sender.                          |
| `gmail-success.test.ts`                     | Gmail success: marks the draft sent after a confirmed Gmail send                                         | A confirmed Gmail send moves the draft into its successful sent state.                 |
| `invalid-prospect-stage.test.ts`            | Invalid prospect stage: rejects an outreach draft when the prospect is not draft_ready                   | Outreach cannot proceed from an invalid prospect stage.                                |
| `message-draft-by-id-missing.test.ts`       | Message draft lookup: returns null when the draft ID does not exist                                       | Job processing fails closed when its referenced draft is missing.                      |
| `message-draft-by-id.test.ts`               | Message draft lookup: returns the exact draft by ID                                                       | A queue job resolves its specific draft instead of selecting another draft.             |
| `outreach-already-sent.test.ts`             | Outreach already sent: rejects a draft because it was already sent                                       | Prevents repeat sending after completion.                                              |
| `outreach-claim-validation.test.ts`         | Outreach claim validation: rejects an unapproved outreach draft                                          | Only an approved draft can be claimed for outreach.                                    |
| `outreach-completion-guard.test.ts`         | Outreach completion guard: rejects completion when the draft is still pending                            | Prevents skipping the required send/processing state.                                  |
| `outreach-concurrent-claim.test.ts`         | Outreach concurrent claim: allows only one worker to claim the same draft concurrently                   | Prevents two callers from claiming the same outreach draft.                            |
| `outreach-duplicate-completion.test.ts`     | Outreach duplicate completion: rejects duplicate completion after the draft is already sent              | Prevents a completed send from being completed again.                                  |
| `outreach-duplicate-reconciliation.test.ts` | Outreach duplicate reconciliation: rejects duplicate reconciliation without mutating the original record | Prevents duplicate reconciliation operations.                                          |
| `outreach-missing-gmail-draft.test.ts`      | Outreach missing Gmail draft: rejects an outreach draft without a Gmail draft ID                         | Prevents sending when Gmail draft identity is missing.                                 |
| `outreach-recipient-mismatch.test.ts`       | Outreach recipient mismatch: rejects an outreach draft with a mismatched recipient                       | Prevents sending to an unexpected recipient.                                           |
| `outreach-reconciliation-guard.test.ts`     | Outreach reconciliation guard: rejects reconciliation when the draft is still pending                    | Reconciliation cannot be applied from the wrong state.                                 |
| `outreach-reconciliation-not-sent.test.ts`  | Outreach reconciliation: confirmed not sent returns draft to pending                                     | Human-verified non-send can safely restore `pending` and `draft_ready`.                 |
| `outreach-reconciliation-rejects-pending.test.ts` | Outreach reconciliation: rejects a draft that is not awaiting reconciliation                       | The resolver cannot reset an ordinary pending draft.                                   |
| `outreach-wrong-prospect.test.ts`           | Outreach wrong prospect: rejects an outreach draft when it belongs to a different prospect               | Prevents cross-prospect draft misuse.                                                  |

## B. Outreach Job Queue Tests

| Test file                                   | Test                                                                                    | What it protects                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `outreach-job-creation.test.ts`             | Outreach job creation: creates a pending outreach job for a draft                       | New jobs start correctly in `pending`.                             |
| `outreach-job-claim.test.ts`                | Outreach job claim: claims the next pending outreach job                                | An eligible pending job becomes `processing`.                      |
| `outreach-job-empty-claim.test.ts`          | Outreach job empty claim: returns null when no pending job is available                 | Empty queues are handled normally.                                 |
| `outreach-job-concurrent-claim.test.ts`     | Outreach job concurrent claim: allows only one worker to claim a pending job            | Prevents queue double-claiming.                                    |
| `outreach-job-completion.test.ts`           | Outreach job completion: marks a processing job completed                               | Valid `processing -> completed` transition works.                  |
| `outreach-job-completion-guard.test.ts`     | Outreach job completion guard: rejects completion when the job is still pending         | Prevents `pending -> completed`.                                   |
| `outreach-job-duplicate-completion.test.ts` | Outreach job duplicate completion: rejects completion when the job is already completed | Prevents repeated completion.                                      |
| `outreach-job-retry.test.ts`                | Outreach job retry: returns a processing job to pending for a later attempt             | Retry state is stored correctly.                                   |
| `outreach-job-retry-delay.test.ts`          | Outreach job retry delay: does not claim a retry before it is available                 | Future `available_at` actually delays claiming.                    |
| `outreach-job-retry-claim.test.ts`          | Outreach job retry claim: claims an eligible retry as a second attempt                  | Eligible retries return to processing and increment attempt count. |
| `outreach-job-failure.test.ts`              | Outreach job failure: marks a processing job failed                                     | Valid terminal failure works.                                      |
| `outreach-job-failure-guard.test.ts`        | Outreach job failure guard: rejects failure when the job is still pending               | Prevents `pending -> failed`.                                      |
| `outreach-job-failed-claim.test.ts`         | Outreach job failed claim: does not claim a terminally failed job                       | Failed jobs stay out of the queue.                                 |
| `outreach-job-requeue.test.ts`              | Outreach job requeue: safely requeues a failed send-ready job                           | Verified-safe manual recovery reuses the failed job without erasing audit state. |
| `outreach-job-requeue-rejects-reconciliation.test.ts` | Outreach job requeue: rejects a draft still awaiting reconciliation          | An ambiguous Gmail outcome cannot be blindly returned to the queue. |
| `outreach-job-stale-detection.test.ts`      | Outreach job stale detection: finds a processing job claimed before the cutoff          | Old abandoned processing jobs can be detected.                     |
| `outreach-job-fresh-detection.test.ts`      | Outreach job stale detection: ignores a recently claimed processing job                 | Fresh processing work is not falsely labeled stale.                |

## C. Production Outreach Processor Tests

| Test file                                               | Test                                                                                | What it protects                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `process-outreach-job-claim.test.ts`                    | Outreach job processing: claims the exact referenced draft                         | The processor sends only the draft named by the claimed queue job.      |
| `process-outreach-job-finalization-throws.test.ts`      | Outreach job processing: finalization failure after confirmed send is non-retryable | A confirmed Gmail side effect is never repeated after a database error. |
| `process-outreach-job-rejected-claim.test.ts`           | Outreach job processing: rejected claim is non-retryable                           | Business-rule rejection cannot enter a retry loop.                      |
| `process-outreach-job-sender-throws.test.ts`            | Outreach job processing: thrown Gmail sender error requires reconciliation          | A thrown Gmail outcome fails closed instead of retrying.                |
| `process-outreach-job-uncertain.test.ts`                | Outreach job processing: uncertain Gmail result requires reconciliation             | Explicit uncertainty persists reconciliation state.                     |
| `resolve-outreach-job-draft-missing.test.ts`            | Outreach job draft resolution: missing draft is non-retryable                       | Missing durable state fails immediately.                               |
| `resolve-outreach-job-draft.test.ts`                    | Outreach job draft resolution: returns the draft referenced by the job              | Draft lookup follows the job's exact `draft_id`.                        |

## D. Worker Behavior and Runtime Tests

| Test file                         | Test                                                                      | What it protects                                         |
| --------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| `outreach-worker-success.test.ts` | Outreach worker success: processes and completes the next job             | Worker coordinates claim -> processing -> completion.    |
| `outreach-worker-empty.test.ts`   | Outreach worker empty queue: returns null without processing a job        | Worker safely handles no work.                           |
| `outreach-worker-retry.test.ts`   | Outreach worker retry: schedules a failed first attempt for retry         | Ordinary early failures go back to pending with a delay. |
| `outreach-worker-failure.test.ts` | Outreach worker failure: marks the third failed attempt terminally failed | Worker stops retrying after max attempts.                |
| `outreach-worker-non-retryable.test.ts` | Outreach worker non-retryable failure: fails on the first attempt   | Side-effect-sensitive failures bypass automatic retry.   |
| `outreach-worker-processor-success.test.ts` | Outreach worker integration: completes a job after a confirmed send | The worker and production processor complete the durable job together. |
| `outreach-worker-processor-uncertain.test.ts` | Outreach worker integration: uncertain send fails without retry   | Gmail uncertainty becomes a failed job requiring reconciliation. |
| `outreach-worker-runtime.test.ts` | Outreach worker runtime: creates a production processor                    | Runtime wiring connects worker processing to Gmail.      |
| `live-outreach-send-guard.test.ts` | Live outreach guard: rejects when live sending is not explicitly enabled   | Production sending defaults to disabled.                 |
| `live-outreach-send-guard-enabled.test.ts` | Live outreach guard: allows live sending when explicitly enabled | The explicit production gate has one auditable opt-in value. |

## E. Worker Logging Tests

| Test file                                 | Test                                                                           | What it protects                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `outreach-worker-logging.test.ts`         | Outreach worker logging: records claim and completion events                   | Successful runs emit `claimed` and `completed`.  |
| `outreach-worker-retry-logging.test.ts`   | Outreach worker logging: records a scheduled retry after processing fails      | Retry runs emit `claimed` and `retry_scheduled`. |
| `outreach-worker-failure-logging.test.ts` | Outreach worker logging: records a terminal failure after the final attempt    | Terminal failure emits `claimed` and `failed`.   |
| `outreach-worker-empty-logging.test.ts`   | Outreach worker logging: records an empty queue event when no job is available | Empty worker runs are visible.                   |

## F. Atomic Reconciliation and Requeue Tests

| Test file | Test | What it protects |
| --- | --- | --- |
| `outreach-job-reconcile-and-requeue-missing-job.test.ts` | Outreach reconciliation requeue: rejects a missing job | Recovery cannot invent or mutate a missing job. |
| `outreach-job-reconcile-and-requeue-rejection-preserves-state.test.ts` | Outreach reconciliation requeue: rejected recovery preserves all state | A rejected recovery attempt leaves the job, draft, and prospect unchanged. |
| `outreach-job-reconcile-and-requeue-rejects-draft-state.test.ts` | Outreach reconciliation requeue: rejects a draft that is not awaiting reconciliation | Only reconciliation-state drafts enter atomic recovery. |
| `outreach-job-reconcile-and-requeue-rejects-message-id.test.ts` | Outreach reconciliation requeue: rejects confirmed sent message evidence | A recorded Gmail message ID blocks requeue. |
| `outreach-job-reconcile-and-requeue-rejects-nonfailed.test.ts` | Outreach reconciliation requeue: rejects a job that is not failed | Active or completed jobs cannot enter failed-job recovery. |
| `outreach-job-reconcile-and-requeue-rejects-prospect-state.test.ts` | Outreach reconciliation requeue: rejects a prospect that is not awaiting reconciliation | Recovery requires the matching prospect reconciliation state. |
| `outreach-job-reconcile-and-requeue-rejects-review-status.test.ts` | Outreach reconciliation requeue: rejects a draft that is no longer approved | Recovery cannot bypass human approval. |
| `outreach-job-reconcile-and-requeue-rejects-sent-at.test.ts` | Outreach reconciliation requeue: rejects confirmed sent timestamp evidence | A recorded send timestamp blocks requeue. |
| `outreach-job-reconcile-and-requeue.test.ts` | Outreach reconciliation requeue: atomically restores a confirmed-not-sent job | Human-confirmed non-send restores all three durable records together. |

## G. Outreach Review and Queue Tests

| Test file | Test | What it protects |
| --- | --- | --- |
| `outreach-review-approve-already-approved.test.ts` | Outreach review approval: rejects an already approved draft | Approval cannot be repeated. |
| `outreach-review-approve-missing-draft.test.ts` | Outreach review approval: rejects a missing draft | Approval fails closed for an unknown draft. |
| `outreach-review-approve-nonpending-draft.test.ts` | Outreach review approval: rejects a draft that is not pending | Approval cannot modify a reconciliation or sent draft. |
| `outreach-review-approve-wrong-prospect.test.ts` | Outreach review approval: rejects a draft belonging to another prospect | Approval requires the exact prospect/draft relationship. |
| `outreach-review-approve.test.ts` | Outreach review approval: changes needs_review to approved | The intended guarded approval transition succeeds. |
| `outreach-review-by-prospect.test.ts` | Outreach review: returns the prospect and outreach draft | Review exposes the relevant prospect and draft together. |
| `outreach-review-latest-draft.test.ts` | Outreach review: returns the latest outreach draft | Review selects the newest outreach draft for the prospect. |
| `outreach-review-missing-prospect.test.ts` | Outreach review: returns null when the prospect does not exist | Missing prospects are handled without mutation. |
| `outreach-review-no-draft.test.ts` | Outreach review: returns the prospect with no draft | A valid prospect remains reviewable before drafting. |
| `outreach-review-queue-approved.test.ts` | Outreach review queue: creates a pending job for an approved draft | An eligible approved draft enters the durable queue. |
| `outreach-review-queue-concurrent.test.ts` | Outreach review queue: allows only one concurrent queue attempt | Concurrent operators cannot create duplicate jobs. |
| `outreach-review-queue-duplicate.test.ts` | Outreach review queue: rejects duplicate queueing without creating another job | Sequential duplicate queue attempts are idempotently rejected. |
| `outreach-review-queue-invalid-stage.test.ts` | Outreach review queue: rejects a prospect that is not draft ready | Only `draft_ready` prospects can be queued. |
| `outreach-review-queue-nonpending.test.ts` | Outreach review queue: rejects a draft that is not pending | Reconciliation or sent drafts cannot be queued. |
| `outreach-review-queue-unapproved.test.ts` | Outreach review queue: rejects an unapproved draft | Human approval remains mandatory before queueing. |
| `outreach-review-queue-wrong-prospect.test.ts` | Outreach review queue: rejects a draft belonging to another prospect | Queueing requires the exact prospect/draft relationship. |

## H. Operator CLI Tests

| Test file | Test | What it protects |
| --- | --- | --- |
| `outreach-operator-inspect-job.test.ts` | Outreach operator inspect: returns the exact joined outreach job | Single-job inspection returns joined job, draft, and prospect state. |
| `outreach-operator-inspect-missing-job.test.ts` | Outreach operator inspect: returns null when job does not exist | Missing job inspection is explicit. |
| `outreach-operator-inspect-queue-excludes-completed.test.ts` | Outreach operator inspect: excludes completed jobs from the default queue | Completed work stays out of the operational queue view. |
| `outreach-operator-inspect-queue.test.ts` | Outreach operator inspect: includes a non-completed outreach job | Pending operational work appears in the queue view. |
| `outreach-operator-inspect-rejects-extra-arguments.test.ts` | Outreach operator args: rejects extra inspect arguments | Inspect cannot silently ignore unexpected input. |
| `outreach-operator-inspect-rejects-invalid-job-id.test.ts` | Outreach operator args: rejects an invalid inspect job ID | Inspect requires a UUID job identity. |
| `outreach-operator-parse-approve-invalid-draft.test.ts` | Outreach operator args: rejects approval with an invalid draft ID | Approval requires a UUID draft identity. |
| `outreach-operator-parse-approve-requires-confirmation.test.ts` | Outreach operator args: rejects approval without confirmation | Approval cannot execute without explicit confirmation. |
| `outreach-operator-parse-approve.test.ts` | Outreach operator args: parses confirmed approval command | The guarded approval syntax is accepted. |
| `outreach-operator-parse-inspect-job.test.ts` | Outreach operator args: parses inspect command with job ID | Exact-job inspection syntax is accepted. |
| `outreach-operator-parse-inspect-missing-job-value.test.ts` | Outreach operator args: rejects inspect when job ID is another option | An option token cannot be mistaken for a job ID. |
| `outreach-operator-parse-inspect-missing-job.test.ts` | Outreach operator args: rejects inspect without a job ID | `--job` requires a value. |
| `outreach-operator-parse-inspect-unknown-flag.test.ts` | Outreach operator args: rejects unknown inspect flag | Inspect fails closed on unknown options. |
| `outreach-operator-parse-inspect.test.ts` | Outreach operator args: parses inspect command | Default queue inspection syntax is accepted. |
| `outreach-operator-parse-queue-requires-confirmation.test.ts` | Outreach operator args: rejects queueing without confirmation | Queue mutation requires explicit confirmation. |
| `outreach-operator-parse-queue.test.ts` | Outreach operator args: parses confirmed queue command | The guarded queue syntax is accepted. |
| `outreach-operator-parse-review-invalid-prospect.test.ts` | Outreach operator args: rejects review with an invalid prospect ID | Review requires a UUID prospect identity. |
| `outreach-operator-parse-review.test.ts` | Outreach operator args: parses review command | Read-only review syntax is accepted. |
| `outreach-operator-reconcile-missing-job-id.test.ts` | Outreach operator args: rejects reconciliation without a job ID | Reconciliation requires an explicit job identity. |
| `outreach-operator-reconcile-rejects-extra-arguments.test.ts` | Outreach operator args: rejects extra reconciliation arguments | Reconciliation cannot silently ignore unexpected input. |
| `outreach-operator-reconcile-rejects-invalid-job-id.test.ts` | Outreach operator args: rejects an invalid reconciliation job ID | Reconciliation requires a UUID job identity. |
| `outreach-operator-reconcile-requires-confirmation.test.ts` | Outreach operator args: rejects reconciliation without confirmation | Confirmed non-send is mandatory. |
| `outreach-operator-reconcile-requires-job.test.ts` | Outreach operator args: rejects reconciliation without job option | Reconciliation requires the `--job` option. |
| `outreach-operator-reconcile-valid.test.ts` | Outreach operator args: parses confirmed reconciliation command | The guarded recovery syntax is accepted. |
| `outreach-operator-run-approve-rejected.test.ts` | Outreach operator runner: rejects an unsuccessful draft approval | Domain approval rejection becomes a visible CLI failure. |
| `outreach-operator-run-approve.test.ts` | Outreach operator runner: executes confirmed draft approval | Confirmed approval reaches the guarded domain action. |
| `outreach-operator-run-inspect-job.test.ts` | Outreach operator runner: inspects the requested job | The runner passes the exact job identity to inspection. |
| `outreach-operator-run-inspect-missing-job.test.ts` | Outreach operator runner: rejects a missing requested job | Missing requested jobs produce an error. |
| `outreach-operator-run-inspect-queue.test.ts` | Outreach operator runner: inspects the default queue | Default inspection reaches the queue read model. |
| `outreach-operator-run-queue-rejected.test.ts` | Outreach operator runner: rejects unsuccessful draft queueing | Domain queue rejection becomes a visible CLI failure. |
| `outreach-operator-run-queue.test.ts` | Outreach operator runner: executes confirmed draft queueing | Confirmed queueing reaches the guarded domain action. |
| `outreach-operator-run-reconcile-not-sent.test.ts` | Outreach operator runner: executes confirmed not-sent reconciliation | Confirmed recovery reaches the atomic reconciliation action. |
| `outreach-operator-run-reconcile-rejected.test.ts` | Outreach operator runner: rejects an unsuccessful reconciliation | Domain recovery rejection becomes a visible CLI failure. |
| `outreach-operator-run-reconciliation-blocked.test.ts` | Outreach operator runner: blocks reconciliation execution until implemented | Missing mutation wiring fails closed. |
| `outreach-operator-run-review-missing.test.ts` | Outreach operator runner: rejects a missing prospect review | Missing prospects produce an error. |
| `outreach-operator-run-review.test.ts` | Outreach operator runner: returns a prospect review | Review reaches the read model and returns its result. |
| `outreach-operator-unknown-command.test.ts` | Outreach operator args: rejects unknown command | Unknown operator actions fail closed. |

## I. Operational Monitoring Tests

| Test file | Test | What it protects |
| --- | --- | --- |
| `outreach-monitor-attention.test.ts` | Outreach monitor: exits two when attention is required | Schedulers can distinguish an operational alert from success or monitor failure. |
| `outreach-monitor-healthy.test.ts` | Outreach monitor: emits JSON and exits zero when healthy | A healthy status produces the documented JSON contract and success exit code. |
| `outreach-monitor-invalid-threshold.test.ts` | Outreach monitor: rejects invalid threshold configuration before querying | Invalid configuration fails closed without touching the database. |
| `outreach-monitor-query-error.test.ts` | Outreach monitor: propagates status-query failures to the CLI error boundary | Database failures reach the command boundary and become monitor errors. |
| `outreach-monitor-thresholds.test.ts` | Outreach monitor: passes configured thresholds to the status query | Environment overrides reach the operational query exactly. |
| `outreach-operations-delayed-job.test.ts` | Outreach operations: does not alert on a delayed pending job | A future retry is visible without being mislabeled as overdue work. |
| `outreach-operations-failed-job.test.ts` | Outreach operations: alerts on a failed job | Terminal failures produce a machine-detectable operator alert. |
| `outreach-operations-invalid-threshold.test.ts` | Outreach operations: rejects an invalid monitoring threshold | Monitoring fails closed on nonsensical threshold configuration. |
| `outreach-operations-overdue-ready-job.test.ts` | Outreach operations: alerts on an overdue ready job | Ready work that is not being claimed becomes visible. |
| `outreach-operations-reconciliation.test.ts` | Outreach operations: alerts on reconciliation state | Uncertain Gmail outcomes remain visible until a human resolves them. |
| `outreach-operations-stale-job.test.ts` | Outreach operations: alerts on a stale processing job | Abandoned processing work produces an operator alert. |
| `outreach-operations-status.test.ts` | Outreach operations: returns a consistent operational snapshot | Aggregate counts remain internally consistent without exposing message content. |

---

# 11. Why There Are Two Different "Claim" Test Groups

This is easy to confuse.

## Outreach draft claim

Examples:

- `outreach-claim-validation.test.ts`
- `outreach-concurrent-claim.test.ts`

These protect the **business/send layer** around a message draft.

## Outreach job claim

Examples:

- `outreach-job-claim.test.ts`
- `outreach-job-concurrent-claim.test.ts`

These protect the **background queue layer**.

Think of it this way:

```text
Message Draft
    |
    | business/send safety
    v
Outreach Job
    |
    | queue/worker safety
    v
Worker
```

They solve related but different concurrency problems.

---

# 12. How to Interpret Negative Tests

A negative test can pass even though an application operation fails.

Example:

```ts
await assert.rejects(
  () => completeOutreachJob(job.id),
  /Outreach job is not processing/,
);
```

Meaning:

```text
Illegal application action: rejected
Test expectation: satisfied
Test result: PASS
```

So:

```text
application action failed = sometimes correct
test failed = test expectation was not met
```

Relay intentionally has many negative tests because it is designed to **fail closed** when state is unsafe or ambiguous.

---

# 13. Testing Procedure

When adding new Relay behavior, use this workflow.

```mermaid
flowchart LR
    A[Describe desired behavior] --> B[Write focused test]
    B --> C[Run focused test]
    C --> D{Expected red failure?}
    D -->|Yes| E[Implement smallest change]
    D -->|No| B
    E --> F[Run focused test]
    F --> G{Green?}
    G -->|No| E
    G -->|Yes| H[Run full suite]
    H --> I[Review git status]
    I --> J[Stage only intended files]
    J --> K[git diff --cached --check]
    K --> L[Commit checkpoint]
```

### Focused development test

```bash
npx tsx --test tests/<domain>/<specific-test>.test.ts
```

### Full suite

```bash
npm test
```

Current healthy result:

```text
tests 136
pass 136
fail 0
```

### Before committing

```bash
git status --short
git add <only intended files>
git diff --cached --check
git commit -m "..."
```

Avoid blindly staging everything with:

```bash
git add .
```

when you can stage the intended files explicitly.

---

# 14. Red -> Green -> Refactor

The test-driven cycle used throughout this phase:

```text
RED
Write a test for behavior that does not exist yet.
Confirm it fails for the reason you expected.

GREEN
Implement the smallest production change that makes it pass.

REFACTOR
Clean up structure without changing behavior.
Run the tests again.
```

A red test is useful only if it actually exercises the behavior you intended.

Example learned during worker development:

- Importing `runOutreachWorkerOnce()` was not enough.
- Until the test actually called it, the test passed even though the worker still threw `"Not implemented"`.
- Once the test invoked the worker, the intended red failure appeared.

---

# 15. Current Safety Rules Worth Remembering

1. **Postgres is authoritative durable state.**
2. **Only pending jobs with `available_at <= now()` can be claimed.**
3. **Concurrent workers must not double-claim the same job.**
4. **`attempt_count` means processing attempts started.**
5. **Retryable pre-Gmail failures return to `pending`; exhausted or non-retryable failures become `failed`.**
6. **A failed job is not automatically reprocessed. Guarded manual requeue requires verified-safe state.**
7. **A stale processing job is detected, not blindly retried.**
8. **Completion/failure functions only accept a job in `processing`.**
9. **Logs/events should describe database transitions only after those transitions succeed.**
10. **Once Gmail send is invoked, thrown or uncertain outcomes are non-retryable and require reconciliation.**
11. **Only a human-confirmed non-send may move `needs_reconciliation -> pending` and `send_reconciliation -> draft_ready`.**
12. **Manual requeue preserves `attempt_count` and `last_error`; audit history is not reset.**
13. **Because `outreach_jobs.draft_id` is unique, recovery requeues the existing job instead of inserting another one.**

---

# 16. What Is Complete vs. What Comes Next

## Production outreach path: complete and covered

- Job creation
- Safe claiming
- Concurrent claim protection
- Empty queue handling
- Completion
- Completion guards
- Retry state
- Retry timing
- Multiple attempts
- Terminal failure
- Failure guards
- Stale detection
- Worker orchestration
- Worker event logging
- Exact draft resolution from `outreach_jobs.draft_id`
- Approved outreach-draft claim and validation
- Production Gmail OAuth/runtime wiring
- Gmail draft sending
- Confirmed-send database finalization
- Non-retryable handling after Gmail invocation
- Reconciliation for thrown or uncertain Gmail outcomes
- Human-confirmed not-sent resolution
- Guarded manual requeue of the existing failed job
- Explicit live-send enablement guard
- Outreach review read model
- Guarded draft approval
- Guarded approved-draft queue creation
- Confirmed operator review, approval, and queue commands

Connecting Gmail to `processJob` is complete. The production worker now constructs the Gmail draft sender and executes `processOutreachJob()` for the claimed queue job.

The governing rule is:

```text
Known failure before Gmail is invoked
    -> normal retry policy may be safe

Confirmed Gmail send
    -> persist message evidence
    -> complete the job

Thrown or uncertain outcome after Gmail is invoked
    -> persist reconciliation state
    -> fail the job without automatic retry
    -> require human verification
```

## Production-validation milestone

A controlled end-to-end Gmail test was successfully completed through the production worker. The first attempt encountered a Gmail API configuration failure. Relay failed closed into reconciliation without retrying. A human confirmed that the message was not sent, the record was explicitly reconciled, and the same failed job was safely requeued. The second attempt sent successfully, Gmail's returned message ID was persisted in Postgres, and the job completed.

This milestone verifies the intended recovery path without changing the rule that ambiguous Gmail outcomes must never be retried automatically.

## What comes next

The read-only monitoring command and production operations runbook now define the first operational layer. Host scheduler activation and alert delivery remain deployment actions requiring explicit production approval. Additional guarded recovery tooling should continue to build on the current fail-closed behavior without weakening the live-send gate, reconciliation requirement, or no-blind-retry boundary.

---

# 17. Quick Reference

```text
createOutreachJob(draftId)
    -> pending

claimNextOutreachJob()
    -> processing
    -> attempt_count + 1

completeOutreachJob(jobId)
    processing -> completed

retryOutreachJob(jobId, error, retryAt)
    processing -> pending

failOutreachJob(jobId, error)
    processing -> failed

findStaleOutreachJobs(cutoff)
    -> read-only detection of old processing jobs

processOutreachJob(job, sendDraft)
    -> resolve exact job draft
    -> claim approved outreach draft
    -> invoke Gmail draft sender
    -> persist confirmed send or reconciliation

runOutreachWorkerOnce(processJob, logger?)
    -> null / completed / pending retry / failed

resolveOutreachReconciliationAsNotSent(prospectId, draftId)
    needs_reconciliation -> pending
    send_reconciliation -> draft_ready
    -> only after human confirmation that Gmail did not send

requeueFailedOutreachJob(jobId)
    failed -> pending
    -> guarded manual recovery of the existing unique job
    -> preserves attempt_count and last_error

getOutreachReview(prospectId)
    -> prospect plus latest outreach draft

approveOutreachDraft(prospectId, draftId)
    needs_review -> approved
    -> requires exact prospect and pending outreach draft

queueApprovedOutreachDraft(prospectId, draftId)
    -> creates one pending outreach job
    -> requires approved/pending draft and draft_ready prospect

getOutreachOperationalStatus(options?)
    -> read-only aggregate queue and reconciliation snapshot
    -> alerts on failed, stale, overdue, or reconciliation state

npm run monitor:outreach
    -> JSON operational snapshot
    -> exit 0 healthy / 2 attention required / 1 monitor error
```

### Worker outcomes

```text
No job:
empty event -> null

Success:
claimed -> completed

Retryable attempt:
claimed -> retry_scheduled

Final failed attempt:
claimed -> failed

Non-retryable Gmail/guard outcome:
claimed -> failed on the current attempt

Verified-not-sent manual recovery:
reconciliation resolved -> same failed job requeued
```

---

## Recommended mental model

If the number of tests starts feeling overwhelming, do not memorize all 136.

Remember the layers:

```text
1. Draft safety
2. Queue state machine
3. Worker orchestration
4. Durability / stale detection
5. Observability
6. Gmail reconciliation safety
7. Guarded manual recovery
8. Human review and operator controls
9. Operational monitoring and alert signals
```

Every test belongs to one of those buckets.
