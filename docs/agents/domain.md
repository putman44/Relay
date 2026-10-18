# Relay domain documentation

Relay keeps its domain and operational knowledge in the documents below. Read the relevant portions before changing or reviewing code in the area they cover, and prefer them, together with the current code, over remembered behavior or generic practice.

Relay has no glossary or ADR directory. Its terminology and decisions are recorded in these documents.

## Read before working

- **`docs/Relay_Migration_Plan.md`**: the n8n migration slices (outreach drafting through approved sending, reply monitoring, reply classification and response drafts, follow-ups, prospect research, client onboarding), their status and acceptance boundaries, required migrations, and per-slice verification notes. Read the slice that matches your change.
- **`docs/Relay_Testing_and_Worker_Guide.md`**: key terms (prospect, message draft, outreach job, worker), the outreach job state machine and legal transitions, claiming, retry behavior and the Gmail side-effect boundary, terminal failure and guarded manual requeue, stale job detection, the test catalog, the testing procedure, and the current safety rules (section 15).
- **`docs/Relay_Production_Operations_Runbook.md`**: non-negotiable production safety rules, the read-only health check, inspection and recovery, the scheduler contract, deployment, and disable and rollback. Read it before touching monitoring, scheduling, deployment, recovery, or operator commands.
- **`docs/N8N_Export_Inventory_2026-10-16.md`**: the inventory of the n8n workflow exports Relay is replacing, their differences from earlier archives, and open findings that need a decision or validation.

Also read the relevant code, tests, migrations under `migrations/`, and deployment files under `deploy/`.

## Use Relay's vocabulary

Use the terms these documents and the code already use, such as prospect, message draft, outreach job, worker, claim, reconciliation, and guarded manual requeue. Do not introduce synonyms for established concepts.

## Surface conflicts

If a change or finding contradicts a documented safety rule, state-machine transition, acceptance boundary, or recorded decision, say so explicitly and cite the document and section. Do not silently override it.

These documents describe the state at the time they were written. When a document and the current code disagree, report the discrepancy rather than assuming either one is correct.
