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
| 4 | Follow-up drafting and sending | Implemented locally: explicit-zone calendar timing, two-touch cap, source-bound drafts/approval, live inbound/MIME preflight, durable send claims and uncertain-send holds. Deployment, scheduling, controlled external acceptance and guarded recovery remain |
| 5 | Prospect intake and research | Implemented locally: durable idempotent intake, bounded public-site evidence, strict sourced output, Drive folder/brief, stored Gmail-draft policy, missing-contact/low-fit holds, durable creation journals and safe checkpoint resume. Provider scopes, deployment, controlled external acceptance, and remaining n8n search/map/Airtable parity remain |
| 6 | Client onboarding | Pending: client identity, onboarding/task uniqueness, safe retries, and exact expected-task reconciliation |

No step is production-complete solely because local tests pass. Keep n8n disabled
while migrating and verify each replacement's external effects during separately
authorized acceptance runs. Retire workflows only after their retained behaviors
have replacements or are explicitly removed from scope.

## Fifth slice: public prospect research

Migration 011 adds the `research_in_progress`, `needs_contact`, and
`research_review` stages, an `industry` field, and one durable research request
per prospect. Migration 012 creates the durable `prospect_intake_requests`
journal. Migration 013 adds `gmail_draft_allowed BOOLEAN NOT NULL DEFAULT false`
to each research request. Apply each migration through the reviewed migration
process before using its corresponding command. Migrations 007-011 were applied
to the development Neon database on October 16, 2026; this documentation change
does not claim that migrations 012-013 were applied to development, production,
or the droplet.

### Durable prospect intake

`npm run prospect:add` accepts an explicitly confirmed private JSON input and
creates a `researching` prospect together with its intake journal row in one
transaction. The normalized website origin is the existing intake identity;
this work does not change or expand that canonicalization policy.

An identical repeat of the same request is idempotent. An identical submission
for an already journaled identity, including one carrying a new request ID,
returns the authoritative request ID already persisted in
`prospect_intake_requests`. Concurrent identical submissions therefore converge
on one prospect and one durable journal row. The unused caller-supplied request
ID is not persisted. Reusing a request ID for different input, or submitting
different input for an existing identity, fails closed for inspection rather
than updating or duplicating the prospect.

```bash
npm run prospect:add -- --input /absolute/path/to/private-prospect.json --confirm-create-prospect
```

The command writes Postgres but does not call Firecrawl, OpenAI, Drive, or Gmail.
Do not commit real prospect input files.

### Stored Gmail-draft policy

Migration 013 conservatively marks existing research requests and newly inserted
rows as Gmail-disabled unless the start path explicitly stores otherwise. Normal
`start` persists `gmail_draft_allowed = true`; `start-safe` persists `false`.
`resume` and `retry-pre-artifact` do not derive policy from the current command
or reconstructed dependencies: they continue using the value stored on the
durable request. Gmail draft creation is reachable only when that stored value
is the literal boolean `true`. A Gmail-disabled request can still complete
research and verified Drive artifacts, then ends in `research_review` without a
Gmail draft or `message_drafts` row.

`start` requires a researching prospect with a supplied HTTPS business website,
an explicit Drive parent folder ID, and a confirmation flag. It reserves the
prospect before any provider call. Relay scrapes the supplied website and up to
four safe same-site page links discovered on its first page. Research treats an
apex host and its `www` host as the same site when the HTTPS scheme matches.
Contact and inquiry paths rank first, then business/service paths; other safe page links
fill remaining slots in their discovered order. Asset links are excluded.
The saved evidence reports skipped out-of-scope links, assets, and pages beyond
the four-page follow-up limit separately from pages that were selected but
failed verification. It does not run the old n8n general web search or map phase. Firecrawl
scrape responses must report a source URL equivalent to the requested URL and a
successful HTTP status. Equivalent means the same HTTPS scheme and path, with
apex/`www` hosts and a trailing slash treated as the same. A reported final URL
may be absent; when present, it must be a string that passes the same check.
Saved pages keep the requested URL. The model receives only those saved pages, has no tools, and must return
the exact research schema. Relay validates sources against fetched pages and
requires a recommended email to appear on its cited page. This is structural
evidence checking; a person must still assess whether claims and copy are true.
The model is instructed to cite one page containing every nonempty contact
field. Relay omits name, role, or phone details not visible verbatim on that
page, records that omission in the brief when space permits, and still rejects
an email that is not publicly evidenced on the cited page.

After validation, Relay creates a Drive folder, a Google Docs research brief,
and, only for A/B fit with a publicly evidenced contact email, a plain-text
Gmail draft. The draft is `needs_review` / `pending` and no send job is created.
Fit C ends in `research_review`; missing email ends in `needs_contact`. Both
retain the brief and create no Gmail draft. Supplied contact, industry, and
discovery question fields are never replaced by model suggestions. A conflicting
contact fails validation and holds the request for human inspection. The brief
retains observations, hypotheses, unknowns, citations, and limitations. It
lists evidenced public email and phone links with their source pages separately
from the selected contact record. Proposed outreach appears only for A/B fit
outside the Dev by Taylor site; it is omitted for C fit and owned-site research.
Gmail copy receives the existing authored Relay signature.
For a controlled research-only run, `start-safe` stores Gmail-disabled policy
before provider work. It stops after verified Drive artifacts in
`research_review`, regardless of fit or public contact, and never enters Gmail
draft creation. The normal `start` path stores Gmail-enabled policy instead.

Each external create call has a committed `*_creating` state first and disables
automatic transport retries. Returned IDs are retained if local finalization
fails. An uncertain outcome becomes `needs_reconciliation` when Postgres is
available; a stranded creating state also blocks another request. Do not delete
the request or start under a new ID to bypass a hold. `resume` accepts only
`research_ready`, `folder_ready`, or `brief_ready` checkpoints, plus a
`researching` request older than two hours that has not begun artifact creation.
It verifies existing Drive artifact IDs and parents before later writes. It
never retries `*_creating` or `needs_reconciliation` automatically. Drive
artifact metadata includes the research request ID to aid manual inspection.
Failed collection or model validation occurs before Drive/Gmail artifact creation.
Validation failures retain a field-level code in `last_error`, without storing
the rejected model response. After inspecting the exact request and prospect,
`retry-pre-artifact` can explicitly reuse that same failed request ID only if
the input is unchanged, no artifact identities or outreach drafts exist, the
prospect is not suppressed, and the configured Drive parent still matches.
It never retries an uncertain external create; the prior error remains on the
request as an audit note after a successful retry.

Configuration: `DATABASE_URL`, `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, an explicit
`RELAY_RESEARCH_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`, and `RELAY_RESEARCH_DRIVE_PARENT_ID`. A deployment Google
refresh token may lack Drive authorization. `scripts/authorize-gmail.ts
--include-drive-file` requests the Gmail compose and Drive file scopes, but a
`drive.file` token must also be able to access the chosen parent folder; verify
this in each deployment environment. No secret or real prospect input is stored
in the repository.

```bash
npm run research -- status --prospect PROSPECT_UUID
npm run research -- start --prospect PROSPECT_UUID --confirm-research
npm run research -- start-safe --prospect PROSPECT_UUID --confirm-research-only
npm run research -- resume --request REQUEST_UUID --confirm-resume
npm run research -- retry-pre-artifact --request REQUEST_UUID --confirm-retry-pre-artifact
```

The four mutation commands can incur Firecrawl/OpenAI usage and create Drive
artifacts. Normal `start`, and a `resume` or `retry-pre-artifact` whose stored
policy is true, may also create a Gmail draft. `start-safe`, and every resumed or
retried request whose stored policy is false, cannot create one. The status
command prints IDs and state without exposing the research content. Inspect a
failed request before the explicit pre-artifact retry; never use it for
`*_creating`, `needs_reconciliation`, or a request with artifact IDs. Firecrawl
may follow redirects or resolve DNS inside its service; Relay validates the
requested and reported source URL but cannot prove Firecrawl's internal fetch
path. A controlled development run on the owned Dev by Taylor site verified
Firecrawl/OpenAI research, three saved pages, Drive parent access, and a Google
Docs brief. It used research-only mode and created no Gmail draft or send job.
Production still needs its own read-only configuration/schema preflight and a
separately approved rollout; Gmail draft appearance and operator review remain
unverified for this research path.

Historical verification checkpoint on October 17, 2026: typecheck and 272/272
full regression tests passed for the code at that checkpoint, including the
then-current step 5 research tests. That checkpoint predates the later durable
prospect-intake and stored Gmail-draft-policy changes and does not validate
them. Those later changes have focused test coverage, described in
[Relay Testing & Worker Guide](Relay_Testing_and_Worker_Guide.md). The October
17 run used fake Firecrawl, OpenAI, Drive, and Gmail providers plus disposable
localhost Postgres; it made no live provider request, production migration,
send, or worker invocation.

Historical regression verification on October 18, 2026, separate from the
October 17 checkpoint: a guarded full-suite run against the local disposable
`relay_test` database passed 285/285 tests, with 0 failed and 0 skipped, for the
branch state at that time. No live Firecrawl, OpenAI, Drive, or Gmail operations
were performed. That run predates the later research status output,
prospect-intake JSON parse-error, and Firecrawl metadata validation changes, so
it does not verify the current branch. No full-suite result is recorded yet for those
changes.

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
on disposable localhost Postgres and applied to development Neon; production
Neon and the droplet remain unchanged. Grant the drafting application the required
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

Database-backed tests require both `DATABASE_URL` and
`RELAY_DRAFT_TEST_DATABASE_URL` to target the guarded local disposable
`relay_test` database, plus `RELAY_TEST_DATABASE_DISPOSABLE=true`. The same
requirements apply to focused database-backed tests, not only `npm test`.
Database-backed suites differ in how much isolation and guarding they provide:

- Isolated-schema integration tests, such as the draft-creation tests, create a
  unique temporary schema, apply migrations there, use fake Gmail, and drop that
  schema afterward.
- The intake and research focused suites also enforce the guarded local
  `relay_test` configuration in-process.
- Older focused database suites do not universally enforce that guard
  in-process when run directly. They depend on the operator having already
  configured the safe local `relay_test` database.

The full-suite pretest guard runs only for `npm test`. Never point either URL at
an application, production, or remote database. If a safety-critical database
test is skipped or cannot run, verification is incomplete; it is not a passing
result.

The focused command below is not automatically guarded. Its draft-creation
suite creates an isolated schema but does not run the guard in-process, so
confirm the safe local `relay_test` configuration above before running it:

```bash
npx tsx --test --test-concurrency=1 tests/gmail/gmail-draft-creator.test.ts tests/outreach/outreach-draft-content.test.ts tests/outreach/outreach-draft-creation.test.ts
```

For a fully isolated regression run, provision a disposable database with all
migrations and set both URLs to its direct loopback connection before `npm test`.
The guard rejects a missing disposable confirmation, a remote or redirected
effective host, or a database name other than `relay_test`. Existing tests use
`DATABASE_URL`; isolated-schema integration tests use
`RELAY_DRAFT_TEST_DATABASE_URL`.

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
verification. The step-3 checkpoint was committed locally as `aac4ff8`.

## Fourth slice: cold follow-up drafting and approved sending

Apply `010_create_follow_up_pipeline.sql` before deploying this application
version. It adds the discovery question, numbered follow-up drafts linked to
their initial outreach, durable `follow_up_draft_requests`, and unique
`follow_up_send_attempts` with the exact approved snapshot. Migration 010 has
been tested only on disposable localhost Postgres, not the application database
or droplet. Initial outreach and response processing remain separate pipelines.

### Timing, scope and copy

The first follow-up becomes due four local calendar days after the confirmed
initial outreach. The second becomes due five local calendar days after the
first **confirmed follow-up send**, not after drafting, approval, or an uncertain
attempt. There is no third touch. These are calendar dates (eligible at local
midnight), not fixed 96-/120-hour delays. IANA zone input is explicit and
canonicalized; the first reservation binds the zone so later runs cannot shift
it to bypass timing. `America/Denver` preserves the exported n8n behavior.

There is no new `follow_up_due` prospect stage: the due date is derived from
confirmed send history. Eligible prospects stay `outreach_sent` until replies or
reconciliation change their state. The original n8n first/last-touch plain copy,
first-name greeting, discovery question/default question, and signature are
preserved. No AI or new paid provider is used. HTML-template parity is not
included; drafts are plain text for strict content inspection.

Exactly one confirmed initial outreach chain is required. Replies (including
automatic replies), opt-outs, cold blocks, unhealthy thread checks, any response
draft/history, ambiguous or legacy unnumbered follow-ups, inconsistent sequence,
and unresolved creation/send state stop the operation. Existing follow-up data
is not silently assigned sequence numbers or treated as a zero count.

### Separate explicit commands

Replace the UUIDs below with existing records. Planning only reads/locks database
state; it does not contact Gmail. Drafting creates a Gmail draft for review.
Approval is database-only and requires review of the exact stored destination,
copy, signature, and thread. None of these commands queues work or enables a
scheduler/worker.

```bash
npm run follow-up -- plan --prospect <UUID> --time-zone America/Denver
npm run follow-up -- draft --prospect <UUID> --time-zone America/Denver --confirm-create-draft
npm run follow-up -- approve --draft <UUID> --confirm-approve
```

An implemented `send --draft <UUID> --confirm-send` subcommand additionally checks
the existing live-send environment guard **before loading database/Gmail
dependencies**. This is a real send operation when deliberately enabled and
invoked, not a preview. It has not been run live. Do not enable the live-send
flag or invoke it as part of local verification; tests inject a fake Gmail API.
The existing initial-outreach worker/operator does not handle follow-ups, and
outreach-only not-sent reconciliation now explicitly rejects them.

### Creation, approval and send safety

Creating a draft checks live thread state before and after Gmail creation and
commits a unique prospect/touch reservation before the non-idempotent POST.
Requests retain authored content, parent IDs, zone/date, source-history hash,
and returned Gmail IDs. Failed, uncertain or interrupted requests block another
creation attempt. Returned IDs are retained where possible when finalization
fails; a DB outage can leave a blocking `creating` reservation instead.

Approval hashes the exact database content, destination, draft/thread identity,
parent, sequence, date, zone, and source history. Changes to approved content or
context do not inherit that approval. A send claim locks the prospect/drafts and
persists a unique preflight attempt plus approved snapshot before Gmail reads.
Concurrent or repeated invocations cannot acquire a second claim.

Actual Gmail MIME preflight requires the approved recipient/copy/thread, no
extra recipients or HTML/attachments, and the exact single `In-Reply-To` and
`References` parent. After MIME inspection, a live full-thread read requires no
inbound since initial outreach and no newer/untracked outbound mail. The last
confirmed sent message must still be the exact parent; encoded subjects are
decoded for comparison. Database eligibility, source history, and approval are
rechecked before invocation. The inspected raw MIME snapshot is supplied to the
send request, not reloaded from a potentially edited mailbox draft. Threading
uses [Gmail's documented requirements](https://developers.google.com/workspace/gmail/api/guides/threads),
and the final [draft-send request](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send)
has automatic transport retries disabled.

A preflight stop records `blocked` and, if the claimed draft remains approved
and unsent, returns it to `needs_edit`/`pending` without claiming an uncertain
send. Concurrent review changes and existing send evidence are not overwritten.
The attempt remains a durable retry block; correction/reapproval/recovery needs
a separately reviewed operation, not another send invocation.

Once the send endpoint is invoked, missing/partial/reused/wrong-thread IDs,
transport errors and failed finalization require human reconciliation. Returned
IDs are recorded in the attempt where possible. The draft and prospect are
marked for send reconciliation where safe, without clearing reply/opt-out
suppression. A complete database outage leaves `sending`/`invoking`, also a
durable retry block. Confirmed sends are recorded even if a reply arrives during
the request; existing reply/reconciliation stages and suppression remain.
Lost commit acknowledgements do not downgrade a successfully persisted send.
The attempt's approved snapshot retains the intended transmitted content for
audit even if another tool edits database copy during the external call.

The reply monitor revokes approval on pending unsent cold follow-up drafts when
it sees an inbound reply, while preserving in-flight/uncertain/confirmed-send
evidence. A live preflight cannot atomically lock Gmail against new mail: a reply
can arrive between the last read and send, or while sending. This implementation
does not promise cancellation of in-flight mail or zero cross-system race time.

### Recovery and remaining acceptance

Read-only inspection (do not delete history or reset state just to retry):

```sql
SELECT id, prospect_id, follow_up_number, status, time_zone, due_date,
       gmail_draft_id, gmail_message_id, returned_gmail_thread_id, last_error
FROM follow_up_draft_requests ORDER BY created_at DESC;

SELECT draft_id, status, sent_message_id, gmail_thread_id, last_error
FROM follow_up_send_attempts ORDER BY created_at DESC;
```

Inspect Gmail, creation requests, send attempts and draft evidence together.
The exact approved snapshot contains private message content; keep its access
restricted and do not paste it into general logs. There is deliberately no
automatic retry/reset/requeue or follow-up recovery command. The initial-outreach
recovery tool is not a substitute. If an acknowledgement was lost, the row may
already be `created`/`sent` despite a command error. Inspect before any recovery.

No production migrations, live Gmail operations, worker activation, timer/Docker
deployment, Airtable integration, or Gmail-label updates are included. Controlled
mailbox acceptance and guarded recovery tooling remain required before launch.

Verification on October 16, 2026: 250/250 full regression tests passed on
disposable localhost Postgres. The final 29-test follow-up subset also passed
after adding the reused-send-ID guard. Typecheck and whitespace checks passed.
All Gmail create/read/send interfaces in these tests were fakes. No live flag,
production migration, scheduler, worker, or external mailbox operation was enabled
or run. The disposable test database was removed after verification. The step-4
implementation is not production-certified by these local results.
