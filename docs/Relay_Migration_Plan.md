# Relay migration from n8n

## Target ownership

Relay will eventually own the Relay-specific business processes in the ten
exports catalogued in `N8N_Export_Inventory_2026-10-16.md`. Gmail, OpenAI,
Firecrawl, and Drive can remain external providers. n8n workflows outside Relay
are independent of this migration. Airtable retention versus replacement with
Postgres and an operator UI remains an explicit product decision.

| Order | Capability | Status and acceptance boundary |
| ---: | --- | --- |
| 1 | Outreach drafting through approved sending | Durable draft creation and actual-draft MIME preflight implemented with fake-Gmail verification; existing approval, queue, send, and reconciliation core retained. Deployment and controlled external acceptance remain |
| 2 | Reply monitoring | Implemented locally: full-thread reading, durable inbound identities, cold-outreach suppression, bounded polling, and unavailable-thread handling. External acceptance and scheduling remain |
| 3 | Classification and response drafts | Implemented locally: validated classification, exact-reply-bound review drafts, stale approval invalidation, opt-out/automatic-message safety, and durable creation journals. External acceptance and managed response approval/send remain |
| 4 | Follow-up drafting and sending | Pending: local calendar dates, two-touch cap, newer-inbound preflight, explicit approval, durable claims, and uncertain-send recovery |
| 5 | Prospect research | Pending: OpenAI/Firecrawl, validated output schema, Drive briefs, missing-contact handling, durable artifact creation and resume/recovery |
| 6 | Client onboarding | Pending: client identity, onboarding/task uniqueness, safe retries, and exact expected-task reconciliation |

No step is production-complete solely because local tests pass. Keep n8n disabled
while migrating and verify each replacement's external effects during separately
authorized acceptance runs. Retire workflows only after their retained behaviors
have replacements or are explicitly removed from scope.

## First slice: supplied outreach copy to a reviewable Gmail draft

`npm run draft:outreach` accepts authored subject/body text for an existing
`researching` prospect. It does not perform AI research or generate copy. It
creates a draft through Gmail's draft-create endpoint, then stores the Gmail
identifiers and content in Postgres with `needs_review` / `pending` status and
moves the prospect to `draft_ready`. Approval and queueing remain separate
operator actions. Draft creation never invokes the send endpoint or queues work.

Before invoking Gmail, Relay commits an `outreach_draft_requests` record. The
prospect is locked during reservation; the table's unique prospect constraint
blocks duplicate requests even after a process crash. Existing outreach drafts
also block creation. Gmail POST retries are explicitly disabled.

If the Gmail result is uncertain, incomplete, or cannot be finalized, the request
is marked `needs_reconciliation` where possible. A database outage can leave it
`creating`; that state also blocks automatic retries. If Gmail returned IDs,
Relay attempts to retain them in the request. The deterministic MIME Message-ID
contains the request UUID as another reconciliation aid. Gmail does not promise
idempotent creation based on that header; the durable database reservation is
the automatic duplicate-creation guard.

If finalization commits but its acknowledgement is lost, the command may report
an error even though the request is already `created`. Inspect both the request
and message draft before deciding recovery is required. Never delete request
history or use a new request ID as a way to bypass a blocked prospect.

### Database preparation

Apply `migrations/007_create_outreach_draft_requests.sql` through the normal
reviewed migration process before using the command. This migration was tested
only on disposable localhost Postgres; it has not been applied to the configured
application database or the droplet. Grant the drafting application the required
table privileges; the read-only Docker monitor does not need access to this table.

### Explicit draft-creation command

Create a private local JSON file with exactly these string keys:

```json
{
  "requestId": "a unique UUID for this request",
  "prospectId": "the existing prospect UUID",
  "recipientEmail": "the prospect's exact contact email",
  "subject": "The supplied subject",
  "body": "The supplied message body, including any desired signature."
}
```

The placeholder UUIDs above must be replaced. Do not commit real prospect input
files. The command requires database access and existing Gmail OAuth settings,
and it changes the Gmail mailbox by creating a draft:

```bash
npm run draft:outreach -- --input /absolute/path/to/private-draft.json --confirm-create-draft
```

Without the exact confirmation flag the script rejects the command before
loading database or Gmail dependencies. Do not use the live-send flag for this
command. It is a distinct, explicitly requested mailbox mutation.

Inspect and approve the returned draft using the existing operator commands only
after reviewing the content and destination. Creating a draft does not enable
the worker. Production activation must still verify the preflight against Gmail
and address the planned reply-monitoring boundary.

### Actual Gmail draft preflight

The production send factory now retrieves the draft with `format=raw` and
validates it against the content captured from the claimed, approved database
record. This is implementation verified with fake APIs; no live mailbox check
has been performed.

- Require the exact Gmail draft ID, a message ID, an unsent DRAFT label, and a
  thread ID matching the stored thread when one is available.
- Decode MIME with the pinned `postal-mime` dependency. Require exactly one To
  header and mailbox matching the approved recipient. Reject Cc, Bcc, Resent
  headers, additional reply routing, and ambiguous/duplicated MIME headers.
- Compare the decoded subject exactly and the plain-text body exactly except
  for CRLF/LF line-ending normalization. Do not trim or ignore added copy.
- Block HTML, multipart MIME, and attachments. The current approved data model
  stores plain text only; legacy n8n HTML/signature representations require an
  explicit migration/review design rather than bypassing inspection.
- Send the inspected raw MIME and thread ID in the final draft-send request.
  Gmail supports supplying message content during draft sending; using that
  snapshot prevents a mailbox edit after inspection from substituting content.
  See [Google's draft API guide](https://developers.google.com/workspace/gmail/api/guides/drafts).
- Disable automatic transport retries on the send request.

A preflight mismatch or retrieval error occurs before send invocation. The
processor marks the draft `needs_edit` / `pending`, records a reason, and fails
the job without automatic retry. The prospect's stage is preserved. It does not
claim an uncertain send or invoke not-sent reconciliation. Correcting the draft
and restoring it to review needs a separate operator action; the existing
approval command deliberately cannot approve `needs_edit` directly.

If recording that block fails or the draft state has changed, the processor
still raises a terminal job error and does not reset newer state. Preserve and
inspect the records before recovery. Errors after the send endpoint has been
invoked continue through the existing uncertain-send reconciliation path.

### Read-only inspection of blocked requests

```sql
SELECT id, prospect_id, status, gmail_draft_id, gmail_message_id,
       gmail_thread_id, last_error, created_at, updated_at
FROM outreach_draft_requests
WHERE status IN ('creating', 'needs_reconciliation')
ORDER BY created_at;
```

Verify Gmail and the corresponding `message_drafts` record before recovery.
There is deliberately no automatic retry, reset, delete, or re-create command
for blocked requests in this slice. A guarded recovery operation is future work.

### Verification

Verification on October 16, 2026: typecheck passed and the full regression suite
passed 170/170 on disposable localhost Postgres, including draft creation and
actual-draft preflight. A focused rerun verified the final preflight guard also
preserves approval revoked during inspection. No live Gmail operations were
performed.

The new integration tests require `RELAY_DRAFT_TEST_DATABASE_URL` pointing to a
disposable, direct Postgres connection. They create a unique temporary schema,
apply migrations there, use fake Gmail, and drop that schema afterward. They
skip when this variable is absent. Never point it at a production database.

```bash
npx tsx --test --test-concurrency=1 tests/gmail/gmail-draft-creator.test.ts tests/outreach/outreach-draft-content.test.ts tests/outreach/outreach-draft-creation.test.ts
```

For a fully isolated regression run, provision a disposable database with all
migrations and set both `DATABASE_URL` and `RELAY_DRAFT_TEST_DATABASE_URL` to its
direct connection URL before `npm test`. Existing tests use `DATABASE_URL`.

## Second slice: reply monitoring

Apply `008_create_reply_monitor.sql` before deploying this code, including the
updated sender and operator. It adds a `replied` stage, a persistent
`cold_outreach_blocked` flag, `prospect_replies`, and `reply_thread_checks`.
Migrations 008 and 009 have not been applied to the application database or droplet.
The updated monitor also requires 009 for stale response-draft invalidation.

The separate, explicitly invoked command is:

```bash
npm run monitor:replies -- --confirm-record-replies
```

This reads Gmail and writes Postgres. It never creates drafts, changes labels,
queues jobs, or sends mail. It requires the existing OAuth configuration with
thread-read permission; live credential/scopes acceptance has not been performed.
No scheduler or Docker deployment for this command is included in this slice.
The existing read-only queue monitor remains separate and requires no Gmail credentials.

Each run processes up to 50 confirmed-sent outreach drafts, oldest checked first.
It validates thread/message identities and timestamps, then records every inbound
message at or after the confirmed outbound Gmail message's timestamp, excluding
SENT and DRAFT messages. The exact stored sent-message ID must be present in the
thread with a SENT label. This avoids missing fast replies that arrive before
database send finalization; same-millisecond inbound is conservatively retained.
Archived messages, automatic replies, and bounces also stop cold outreach; their
classification belongs to step 3. Identity is unique per prospect/message, so
repeated polls cannot duplicate events. Latest reply is derived by ordering
`received_at DESC, gmail_message_id DESC`; older delayed polls cannot replace it.
Only metadata/snippets are retained here; full reply body extraction belongs to
classification. Never treat snippets as complete reply content.

Reply recording locks the prospect and rechecks the exact sent draft before
committing. It sets durable suppression and `replied`, except that an existing
`send_reconciliation` stage is preserved. Queueing and send claims reject blocked
prospects even if their stage is later reset. Existing sending/uncertain drafts,
jobs, and confirmed-send evidence are not reset. Finalizing an already-in-flight
send preserves recorded replies and suppression. This cannot cancel a send
already claimed/in flight, and polling is not a freshness guarantee: step 4 must
add a live newer-inbound check immediately before any follow-up send.

404/410 thread reads are recorded as `unavailable`, permanently block cold
outreach, and stop polling that draft pending human repair. Other read failures,
including authentication, rate limiting, invalid input, and incomplete responses,
record `error` and are retried on subsequent polls. Any non-OK check blocks queue
and send claims. A later successful poll clears a transient check, but never
clears durable reply/unavailable suppression. There is deliberately no automatic
unblock command. Inspect Gmail, prospect replies, and thread checks before a
separately reviewed repair; do not reset flags just to resume sends.

The command emits aggregate counts only and exits nonzero for read errors,
persisted non-OK checks (including unavailable threads skipped this run), or
persistence failures. Successful writes for earlier targets remain committed if
a later target fails. Query `reply_thread_checks` for per-draft status. No raw
Gmail errors, message bodies, or recipient addresses are logged by this command.
Records with missing confirmed-send/thread identity are not polling candidates;
existing reconciliation tooling remains responsible for resolving those cases.

Tests use fake thread readers and disposable Postgres only. They cover duplicate
and concurrent polls, older replies, malformed messages, unavailable/transient
failures, fair bounded polling, changed-draft rollback, queue/claim suppression,
and preservation of in-flight/reconciliation state. The new isolated-schema
integration test uses `RELAY_DRAFT_TEST_DATABASE_URL`, as described above.

Verification on October 16, 2026: 189/189 full regression tests passed on
disposable localhost Postgres. After the final archived-message handling change
and its additional regression test, the 20-test reply-monitor subset passed
again. Typecheck and whitespace checks passed. No application/droplet migrations,
Gmail requests, outreach sends, or production worker invocations occurred.

## Third slice: classification and review-only response drafts

Apply `009_create_reply_processing.sql` before deploying this version of the
monitor, operator, sender, or reply processor. This adds the opt-out flag,
reply-bound response drafts, and durable `reply_processing_requests`. Each
prospect/reply pair has one unique processing reservation. Classification records
and newly created response drafts remain `needs_review`. This is not a response
send pipeline: no approval, queue, or send operation is invoked, and the existing
outreach worker/operator rejects response draft types.

The explicit command is:

```bash
npm run reply:process -- --prospect <existing-prospect-UUID> --confirm-create-response-draft
```

Replace the UUID before running. The flag authorizes processing that prospect's
latest recorded reply, including reading Gmail, sharing full reply/original
outreach text with OpenAI, writing classification state, and potentially creating
a Gmail response draft. It does not authorize sending mail. Run reply monitoring
first. The command has not been run against a real mailbox or provider.
It is not scheduled or included in the read-only Docker monitor.

Configuration requires existing database/Gmail OAuth settings plus private
`OPENAI_API_KEY` and an explicitly chosen `RELAY_REPLY_MODEL` that supports the
Responses API and strict structured outputs. No default model or account access
is assumed; model/scopes/credentials acceptance remains pending. Never commit
keys or real prospect input files. The provider adapter uses a fixed HTTPS
endpoint, no tools, `store: false`, a 45-second timeout, and no automatic retries.
`store: false` is not a promise of zero provider-side retention; review the
provider's data terms before processing real mail.

The adapter follows [official OpenAI structured-output guidance](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
Every object or JSON string follows the same local required-key/type/enum/size
validation. Refusals, incomplete responses, extra fields, invalid JSON,
contradictory actions, and low-confidence draft requests fail before Gmail
creation. Email/company content is untrusted input, not instructions or tool
authority. Schema validity does not establish semantic correctness; human review
of every proposed response remains essential.

Supported classes preserve the n8n intent: Interested, Scheduling Intent,
Question / Objection, Referral / Wrong Contact, Not Interested, Out of Office,
and Unclear, with an explicit Opt Out class. Only the first three may draft, at
High/Medium confidence. Referral messages never automatically choose a new
contact or create a third-party response. All no-draft decisions have empty
response copy and no Gmail draft reference. Out-of-office decisions do not
schedule future contact in this slice.

Common explicit opt-out phrases (including quoted copy) trigger a conservative
local stop before AI, and automatic-message headers trigger manual review with
no draft. Model-classified Opt Out also persists `communication_opted_out`.
That flag independently blocks outreach queueing/claims and future response
creation, even after stage/cold-flag changes. There is no automatic opt-in or
unblock operation. Phrase matching is deliberately conservative, not a complete
natural-language detector or a compliance certification; review opt-out meaning
and false positives manually. All inbound replies already block cold outreach.

The exact inbound Gmail ID is fetched as raw MIME. Full plain text is required;
there is no snippet fallback or attachment/HTML-only ingestion. Ambiguous sender
or Reply-To, a destination different from the known contact, missing/unsafe RFC
Message-ID, oversized content, or attachment-bearing messages stop for manual
review. From/Reply-To matching is not cryptographic sender authentication.
Responses retain the reply subject and parent identity and provide an explicit
thread ID, following [Gmail's threading requirements](https://developers.google.com/workspace/gmail/api/guides/threads).
The body preserves the model's proposed plain text and appends the authored
n8n plain-text signature unchanged. The legacy HTML template is not migrated;
this slice deliberately creates plain-text drafts compatible with strict MIME
inspection. Review both proposed copy and signature before any later approval.

Before AI and around creation, live thread checks require the selected reply to
still be latest. Database transactions recheck latest reply, contact, opt-out,
and send-reconciliation state under the prospect lock. A durable `creating`
reservation precedes the Gmail POST, whose transport retries are disabled. New
replies seen during creation withhold a locally reviewable response and retain
returned IDs for reconciliation. Incoming mail cannot be atomically synchronized
with Gmail draft creation: stale drafts can still appear in Gmail, so review
them manually. No mailbox drafts are deleted by this implementation.

The monitor revokes approval on older unsent/pending response drafts, marks their
processing records stale, and preserves their Gmail IDs. A superseded `creating`
request becomes reconciliation-required. Sending, uncertain, and confirmed-send
draft evidence is never reset. No-draft processing does not reuse an older
response reference. A future response-send pipeline must check exact latest
reply identity and approved MIME again immediately before sending; it cannot
rely on an old classification or polling result.

Any provider/read/validation failure leaves a durable failed reservation rather
than automatically rerunning the same reply. An uncertain Gmail create, wrong
thread, or failed finalization records `needs_reconciliation` and returned IDs
where possible. A database outage can leave `creating`, which also blocks a
duplicate attempt. A lost database commit acknowledgement can report an error
even when the request is already `created`; inspect both tables. Never delete
request/reply history or generate a new ID to bypass these protections.

Read-only recovery inspection:

```sql
SELECT id, prospect_id, source_reply_message_id, status, review_status,
       gmail_draft_id, gmail_message_id, gmail_thread_id, last_error
FROM reply_processing_requests
ORDER BY created_at DESC;
```

No automatic recovery/reset command is provided. No production migration, live
provider evaluation, Gmail acceptance, scheduling, or managed response
approval/send has been performed. Retain the disabled n8n exports until these
remaining acceptance/feature boundaries are deliberately resolved.

Verification on October 16, 2026: 219/219 full regression tests passed on
disposable localhost Postgres. A final 51-test reply-processing/monitoring subset
also passed, including the additional CLI and in-progress-creation race tests.
Typecheck and whitespace checks passed. All Gmail/classification providers were
simulated; no real drafts, emails, or OpenAI requests were made. Migration 009
was applied only to disposable local test databases, which were removed after
verification. The step-3 changes remain uncommitted pending review.
