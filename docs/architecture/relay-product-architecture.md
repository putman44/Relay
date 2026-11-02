# Relay Product Architecture v2

## Product Goal

Relay is a business research and relationship-management application.

A user adds a business. Relay stores the business as a durable record, researches the business when public website information is available, organizes what it learns, assists with outreach, and tracks the ongoing communication history with that business.

Relay itself is the system of record. External services such as Firecrawl, OpenAI, Gmail, and Google Drive provide capabilities but should not own Relay's core data.

---

## Core User Flow

```text
Add Business
    ↓
Create Prospect
    ↓
Website available?
    ├── No → Prospect remains usable without research
    │
    └── Yes
         ↓
      Queue Research
         ↓
      Firecrawl Website
         ↓
      Store Raw Research
         ↓
      Extract Structured Facts
         ↓
      Create Embeddings
         ↓
      Prospect Ready
         ↓
Generate Outreach Draft
         ↓
Human Review + Approval
         ↓
Outreach Worker
         ↓
Gmail
         ↓
Track Replies
         ↓
Communication Timeline
```

---

## 1. Relay Web Application

The web application should eventually provide four primary surfaces:

### Business Intake

Create a new business/prospect.

Possible fields:

```text
Business name
Website optional
Industry optional
Contact name optional
Contact email optional
Notes / discovery question optional
```

Website should not be required.

Submitting the form should create the prospect immediately.

Research should happen asynchronously afterward.

---

## 2. PostgreSQL as the Source of Truth

PostgreSQL should contain all durable Relay state.

Core areas include:

```text
prospects
contacts
research requests
research documents
research chunks
communications
outreach drafts
jobs
reply processing
events / audit history
```

External services should never be the only place important business information exists.

---

## 3. Structured Business Data

Facts that Relay knows explicitly belong in normal SQL columns.

Examples:

```text
company_name
website
industry
contact_name
contact_email
phone
prospect_stage
last_contacted_at
last_replied_at
created_at
updated_at
```

SQL answers questions such as:

```text
Which businesses have not replied?

Which prospects are in healthcare?

Which companies were contacted this week?

Which prospects are ready for outreach?
```

---

## 4. Research Documents

Firecrawl output should be stored inside Relay rather than making Google Docs the canonical research artifact.

Possible table:

```text
research_documents

id
prospect_id
research_request_id
source_url
page_type
title
content
scraped_at
created_at
```

One business may have several documents:

```text
Homepage
About
Services
Contact
Team
FAQ
Case Studies
Blog pages
```

This preserves the original evidence Relay used.

---

## 5. Vector Search

Relay should use PostgreSQL with pgvector rather than immediately introducing a separate vector database.

Research documents can be divided into smaller searchable chunks.

```text
research_chunks

id
prospect_id
research_document_id
content
embedding
source_url
chunk_index
created_at
```

The embedding allows Relay to perform semantic searches across business research.

Example:

```text
"What businesses mention difficulty scheduling customers?"
```

Vector search may find relevant website content even when the exact words "difficulty scheduling customers" do not appear.

---

## 6. SQL + Vector Retrieval

Some Relay questions require structured SQL.

Some require semantic search.

Some require both.

Example:

```text
"Which healthcare businesses have not replied and appear to use manual intake?"
```

Relay could process that as:

```text
SQL

industry = healthcare
contacted = true
reply = false

        +

VECTOR SEARCH

manual intake
paper forms
call to schedule
manual registration
```

Then Relay combines the results.

This eventually becomes the foundation for an Ask Relay feature.

---

## 7. Ask Relay

Relay can eventually expose a natural-language interface over the business database.

Examples:

```text
Which prospects look like the best fit for automation?

What does Dev by Taylor specialize in?

Which companies have not responded to us?

Which businesses mention appointment scheduling?

Which prospects should I follow up with this week?

What have we talked about with ABC Company?
```

The AI decides whether the question requires:

```text
SQL
Vector search
Communication history
or a combination
```

Answers should preserve links to the source business and, where appropriate, the research source URL.

---

## 8. Research Worker

Research should become a background job.

Normal usage should not require:

```text
npm run research ...
```

Instead:

```text
Business submitted
    ↓
research job created
    ↓
worker claims job
    ↓
Firecrawl
    ↓
OpenAI extraction
    ↓
research stored
    ↓
embeddings created
    ↓
job completed
```

The UI can simply show:

```text
Researching...
```

while this happens.

The existing durable request/checkpoint design should remain.

---

## 9. Structured Research Extraction

OpenAI should convert research evidence into useful structured information.

Possible output:

```text
Business summary
Industry
Services
Products
Target customers
Public contact information
Potential pain points
Possible outreach angle
Important observations
```

Structured values can be written to SQL.

Longer source material remains in research documents/chunks.

AI-generated facts should retain evidence references where practical.

---

## 10. Prospect Dashboard

The prospect page becomes the primary user interface.

Example:

```text
DEV BY TAYLOR

Status
Ready for Outreach

Website
devbytaylor.com

Contact
Taylor Putman
email@example.com

BUSINESS SUMMARY

Custom software and automation...

SERVICES

• Web development
• Automation
• AI integration

RESEARCH

Potential opportunity:
...

Sources:
Homepage
Services page
About page

COMMUNICATION

Nov 1   Added to Relay
Nov 1   Research completed
Nov 2   Outreach draft created
Nov 2   Email approved
Nov 2   Email sent
Nov 4   Reply received
```

Users should not need to understand internal worker states during normal operation.

---

## 11. Communication Data

Gmail should be treated as a communication transport.

Relay should own the relationship history.

A communication record might include:

```text
communications

id
prospect_id
direction
channel
gmail_message_id
gmail_thread_id
subject
body
sent_at
received_at
status
created_at
```

Possible direction:

```text
inbound
outbound
```

This creates one unified communication timeline.

---

## 12. Outreach

Research may happen automatically.

Sending messages should remain human-controlled.

```text
Generate Outreach Draft
        ↓
AI creates draft
        ↓
Human reviews
        ↓
Human edits if necessary
        ↓
Human approves
        ↓
Job queued
        ↓
Outreach Worker
        ↓
Gmail
```

The existing live-send safety gate should remain.

Live sending must never silently become enabled.

---

## 13. Reply Tracking

After sending:

```text
Gmail thread ID stored
        ↓
Reply monitor checks Gmail
        ↓
Reply detected
        ↓
Inbound communication recorded
        ↓
Prospect becomes Replied
```

Relay can optionally classify replies:

```text
Interested
Question
Not interested
Out of office
Unsubscribe
Other
```

It can then optionally prepare a response draft.

Response sending should still require human approval.

---

## 14. Google Drive / Google Docs

Google Docs should no longer be core storage.

Instead:

```text
Postgres
= canonical research

pgvector
= semantic search

Google Docs
= optional export
```

Relay could eventually offer:

```text
Export Research Report
```

which creates a Google Doc when a human-readable external report is useful.

Deleting a Google Doc would therefore never destroy Relay's research knowledge.

---

## 15. Worker Architecture

Relay should eventually have several small workers rather than one giant worker.

```text
Research Worker
    Firecrawl
    OpenAI
    Embeddings

Outreach Worker
    Gmail sending

Reply Worker
    Gmail monitoring
    Reply persistence

Follow-up Worker
    Scheduling / reminders
```

All workers operate against the same durable Postgres state.

---

## 16. Safety Model

Existing Relay safety principles should remain:

```text
Durable request IDs
Idempotent operations
Explicit checkpoints
Bounded retries
Reconciliation for uncertain external actions
Human approval before sending
Live send disabled by default
Fail closed when state is uncertain
No silent retries after ambiguous external sends
Source-backed research
No invented contact information
```

These safeguards become even more important as Relay becomes more automated.

---

## 17. Simplified User Stages

The user-facing application should use simple stages such as:

```text
New
Researching
Ready for Outreach
Draft Ready
Contacted
Replied
Closed
Needs Attention
```

Internal worker state can remain much more detailed.

For example:

```text
researching
brief_creating
retry_scheduled
folder_creating
needs_reconciliation
```

Those states belong primarily to Relay's execution machinery rather than the everyday UI.

---

## 18. Proposed Long-Term Architecture

```text
                    ┌───────────────────┐
                    │     Relay UI      │
                    │                   │
                    │ Intake            │
                    │ Prospects         │
                    │ Research          │
                    │ Communications    │
                    │ Ask Relay         │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │    PostgreSQL     │
                    │    + pgvector     │
                    │                   │
                    │ prospects         │
                    │ contacts          │
                    │ research_docs     │
                    │ research_chunks   │
                    │ communications    │
                    │ drafts            │
                    │ jobs              │
                    └─────────┬─────────┘
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
      Research Worker   Outreach Worker    Reply Worker
             │                │                │
        Firecrawl            Gmail            Gmail
             │                │                │
          OpenAI              │             OpenAI
             │                │                │
        Embeddings            │                │
             │                │                │
             └────────────────┼────────────────┘
                              │
                              ▼
                           Postgres
```

---

## Implementation Roadmap

### Phase 1 — Data Foundation

- Make website optional.
- Add durable research-document storage.
- Add research-chunk storage.
- Add communication records.
- Prepare PostgreSQL for pgvector.
- Do not change live outreach behavior.

### Phase 2 — Research Pipeline

- Store Firecrawl evidence directly in Postgres.
- Extract structured business facts.
- Chunk research documents.
- Generate embeddings.
- Remove Google Docs from the required research path.
- Keep Google Doc generation as optional export.

### Phase 3 — Prospect Application

- Build prospect list.
- Build prospect detail page.
- Display research.
- Display communication timeline.
- Display simple user-facing status.

### Phase 4 — Automatic Workers

- Automatically queue research after intake.
- Schedule research worker.
- Schedule reply monitor.
- Preserve explicit outreach approval.

### Phase 5 — Ask Relay

- Implement SQL retrieval.
- Implement vector retrieval.
- Implement combined SQL + vector queries.
- Add source citations.
- Build natural-language Ask Relay interface.

### Phase 6 — Production Hardening

- Worker deployment.
- Dedicated DB roles.
- Secret management.
- Monitoring.
- Operational dashboards.
- Backups.
- Production migration process.
- Security review.

---

## Recommended First Codex Implementation Slice

Create a focused first issue:

> **Relay Architecture Phase 1: canonical research storage foundation**

Scope:

1. Make prospect website optional.
2. Add `research_documents`.
3. Add `research_chunks`.
4. Add `communications`.
5. Add pgvector migration/support.
6. Add repository/types/tests for those structures.
7. Do **not** change Gmail sending.
8. Do **not** automatically invoke Firecrawl/OpenAI yet.
9. Do **not** remove the existing Google Docs path yet.

This creates the new data foundation without disrupting the existing working outreach and research flows.

---

## Architectural Principle

**Relay owns the data.**

Workers perform tasks for Relay.

Postgres stores durable truth.

pgvector makes business research searchable.

Firecrawl gathers information.

OpenAI interprets information.

Gmail transports communication.

Google Docs exports information.

The Relay application brings everything together.
