# n8n export inventory — 2026-10-16

## Evidence and scope

Ten JSON exports were copied, byte-for-byte verified, from Downloads into:

`/Users/putman_taylor/Desktop/vscode/AI Automation Business/n8n_workflows/FRESH_EXPORTS_2026-10-16/`

The source downloads and archived exports were preserved. Comparisons below use
`ARCHIVE_2026-10-16_before_fresh_exports`, matching nodes by name rather than
array position. This is static inspection of exported definitions, not runtime
certification. No workflow, API call, database query, or email send was executed.

All ten exports record `active: false` and empty `pinData`. All 52 JavaScript
code-node bodies passed syntax compilation without execution. All connection
targets resolve to nodes present in their respective exports. These checks do
not establish credential validity, external field schemas, expression runtime
behavior, webhook registration, or deployed/published-version equivalence.

## Inventory and migration coverage

| Export | Nodes | Responsibility | Current TypeScript coverage |
| --- | ---: | --- | --- |
| Outreach Approval + Send | 21 | Select approved Airtable prospects, verify a stored Gmail draft, send, update Airtable and Gmail labels | Approval/queue/send/reconciliation core exists; Airtable integration, live draft preflight, and label updates are not equivalent implementations |
| Follow-Up Draft Builder | 12 | Select due prospects, check live thread state, build a threaded MIME draft, save review state | Not implemented |
| Follow-Up Approval + Send | 15 | Validate approval and follow-up cap, check newer replies and draft destination, send, increment count and schedule next follow-up | Not implemented |
| Reply Response Approval + Send | 15 | Validate approval and classified reply identity, check newest inbound message and reply destination, send, update state and labels | Not implemented |
| Research Recovery Watch | 3 | Flag one research claim older than 120 minutes for human reconciliation | Outreach monitoring exists, but research recovery is not implemented |
| Relay Error Handler | 3 | Normalize n8n failure context and send an alert email | Monitor exit statuses/logging exist; this n8n email alert behavior has no equivalent delivery integration |
| Relay - Closed Won Onboarding Builder | 24 | Upsert a client, create/reuse onboarding, create missing template tasks, verify, mark review complete | Not implemented; this workflow is absent from the nine-file archive |
| Prospecting Research Agent | 35 | Select and claim a research prospect, research through OpenAI/Firecrawl, create Drive artifacts and a Gmail draft for review, resume or flag incomplete work | Not implemented |
| Reply Monitor | 19 | Read Gmail threads, detect newer inbound replies, update labels/state, initialize and mark follow-up dates due | Not implemented; the TypeScript monitor checks queue health rather than Gmail replies |
| Reply Classifier + Draft Builder | 22 | Extract a stored reply, classify through OpenAI, create a threaded Gmail response draft or record a no-draft decision for review | Not implemented |

The repository's draft-type enum includes follow-up and response values, but
that is not evidence of implemented pipelines. Likewise, Relay's outreach queue
monitor is not a replacement for an inbox reply monitor.

## Differences from the archived exports

- **Outreach:** 21 nodes versus 14. The existing send-path node parameters match
  the archive (apart from note sizing). A new hourly-at-:17 trigger replaces the
  archived schedule node named Every 30 Minutes. Added webhook and manual SQL
  branches are described below.
- **Follow-up builder:** the same processing nodes and code bodies. Its new
  trigger is hourly at :27. `Save Follow-Up Draft` no longer explicitly clears
  `Follow-Up Review Notes` or `Automation Error`.
- **Follow-up send:** the same processing code. Its new trigger is hourly at
  :37. The live-thread URL has added leading whitespace inside its expression
  string; runtime acceptance has not been verified. The label-body expression
  differs only in formatting, and `Mark Follow-Up Sent` no longer explicitly
  clears `Automation Error`.
- **Response send:** the same processing code. The trigger now explicitly uses
  cron `23,53 * * * *`. The selector and label-body expressions differ only in
  formatting. `Mark Response Sent` no longer explicitly clears `Automation Error`.
- **Research recovery:** the selector and update values match. Its new trigger
  runs every two hours at :47. Airtable schema metadata was reduced/reordered.
- **Error handler:** node parameters, connections, and settings match the archive;
  export identity metadata can differ.
- **Research agent:** 35 nodes in both copies, with the same connections apart
  from the schedule replacement. Runs every two hours at :07. Most code matches;
  `Already Processed - Stop` now accepts both normalized and raw Airtable fields.
  `Mark Needs Contact` no longer explicitly clears contact email or Gmail
  draft/thread IDs. Other changes are note sizing and Airtable schema metadata.
- **Reply monitor:** 19 nodes in both copies, with matching processing code and
  connections. Despite the node name `Every 10 Minutes`, its actual fresh cron
  is `13,43 * * * *` (twice hourly). The selector differs only in formatting.
  Follow-up initialization and due-state writes no longer clear Automation Error.
  The search omits explicit `returnAll` and `limit`; effective defaults and full
  record coverage require runtime/version verification.
- **Reply classifier:** 22 nodes in both copies, with matching code bodies and
  processing connections. Its fresh cron is `18,48 * * * *`. The selector differs
  only in formatting. Both classification save paths no longer clear response
  review notes or Automation Error; the no-draft path also stops clearing
  Response Draft ID. Remaining changes are note text and schema metadata.
- Eight exports (all except Onboarding and Error Handler itself) reference the
  supplied Error Handler workflow ID and specify the same-owner caller policy.
  Only Response Send explicitly has `availableInMCP: true`. The three send
  workflows have a 240-second timeout; Research Agent has a 1500-second timeout.
- Onboarding has no explicit error-workflow reference or execution timeout in
  its exported settings. Its minute-based schedule omits an explicit interval
  number; effective defaults were not verified.

## Findings requiring a decision or validation

### 1. Outreach webhook branch is incomplete

`Webhook` -> `Extract Outreach Record ID` -> `Validate Outreach Request` ->
`Get Outreach Prospect` ends without connecting to approval/send processing.
`Get Outreach Prospect` has an empty table value and no record-ID parameter.
The webhook parameters contain no explicit authentication configuration. The
export therefore does not establish a working, authenticated send endpoint.

The manual trigger connects only to two diagnostic SQL nodes. Their queries
select database time/name; neither is connected to Gmail sending.

### 2. n8n sending still needs concurrency and ambiguous-outcome handling

The scheduled send branches read an approved record, validate it, invoke Gmail,
then persist completion in Airtable. No atomic job claim or explicit
uncertain-send reconciliation state is visible in those paths. A limit of one
record per search does not establish protection against overlapping executions.
Server-level concurrency controls were not inspected.

If Gmail sends but the subsequent state update fails, an error alert alone does
not establish whether the message was sent. Preserve Relay's durable queue and
reconciliation model when implementing these remaining send pipelines.

### 3. Destination checks inspect To, without explicit Cc/Bcc rejection

Outreach, follow-up, and response preflight code extracts addresses from the
stored draft's `To` header. Those code bodies do not explicitly reject extra
`Cc` or `Bcc` recipients. Review all recipient headers when defining migration
acceptance tests.

### 4. Onboarding task verification is weaker than exact reconciliation

`Verify Final Task Set` compares the number of unique returned automation keys
with `templateCount`. It does not compare exact expected keys or detect duplicate
rows hidden by Set deduplication. Equal counts can therefore pass even when a
required template task is missing and an unexpected key is present.

`Build Missing Task Batches` checks stored keys before creation, but the export
does not show atomic uniqueness enforcement. `Create Onboarding` and
`Create Task Batch` enable retries on POST operations without a visible upsert
key, so a successful write followed by a lost response could produce duplicates.
Client upserts use a normalized company-name slug; collisions also need testing.

### 5. Follow-up count validation differs between builder and sender

The builder rejects negative counts. `Validate Follow-Up Approval` checks
finiteness and the upper cap but does not reject negative or fractional counts.
Both pipelines need a shared non-negative integer invariant in the migration.

### 6. Research object output bypasses validation

`Validate Agent Output` returns immediately when the AI output is already an
object, marking it `validJson: true`. Required-key and fit-enum checks run only
for string output parsed later. An object with missing or invalid fields can
therefore reach downstream processing without those checks. Use one schema
validation path regardless of whether output arrives as text or an object.

The research claim is a separate Airtable update after search, rather than an
atomic conditional claim visible in the export. Drive creation and Gmail draft
creation are separate from persistence of their IDs. Resume logic helps with
recorded artifacts but cannot prove absence of unrecorded external artifacts.
Carry durable claiming and explicit recovery into the replacement.

### 7. No-draft classifications can retain an older response draft reference

`Save Reply Classification - No Draft` updates classification identity and
review state without clearing Response Draft ID. The archived version explicitly
cleared it. This can leave a stale draft attached to the newly classified reply.
The exported send path still has human-approval and live reply checks, so this
observation is not evidence that an unapproved send occurred. Define explicit
draft invalidation/version binding in the migration.

### 8. Reply handling relies on cross-workflow state updates

The monitor detects a reply, clears Next Follow-Up, and sets Stage to Replied.
Its first follow-up date is four local calendar days after outreach, and later
follow-up is five days after last contact, with a cap of two. Replied records and
records with Response Review Sent are kept out of generic cold follow-up logic.

The classifier processes the stored Last Reply Message ID; it does not re-read
the Airtable record after AI processing before saving its result. Response Send
does perform a live newest-inbound preflight, which is useful, but migration
tests must also cover a newer reply arriving during classification/draft creation.
The classifier explicitly prohibits auto-drafting for Not Interested, Out of
Office, and Unclear, and saves generated drafts as Needs Review. Preserve those
human-review boundaries.

## Export completeness

The fresh folder now covers all nine archived workflows plus the additional
Closed Won Onboarding Builder. This completes the local export inventory, not
an inventory of every workflow deployed on n8n. Website webhook consumers,
other n8n folders, credential permissions, server concurrency controls, and
external state remain outside this inspection.

## Next actions

1. Decide which research, follow-up, reply, and onboarding capabilities belong
   in the first Relay production release versus a later release or retained n8n.
2. Verify website webhook consumers and the Airtable-to-Postgres data boundary.
3. Define acceptance tests for each retained behavior, including draft identity,
   all recipient headers, newer inbound messages, concurrent claims, ambiguous
   send outcomes, common research schema validation, draft invalidation, and
   exact onboarding task reconciliation.
4. Keep raw exports separate from source code and production credentials. A
   limited scan found no common bearer/API-key/private-key patterns, but these
   JSON files still include credential references, infrastructure identifiers,
   and operational/contact details; they are not certified public-safe.
