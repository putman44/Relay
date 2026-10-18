# Claude Code Instructions

Read `AGENTS.md` before performing Relay work. `AGENTS.md` is the authoritative repository-wide engineering handbook.

Use the project skills under `.claude/skills/` for Relay workflows:

- `relay-implement` for approved implementation work.
- `relay-review` for independent read-only review work.

Preserve Relay's existing safety properties, including fail-closed behavior, idempotency, transactions, locking, reconciliation, approval boundaries, and external-effect protections.

Do not weaken production, database, provider, or human-approval safeguards.
