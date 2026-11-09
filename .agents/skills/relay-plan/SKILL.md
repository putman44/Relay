---
name: relay-plan
description: "Create a read-only, issue-driven Relay implementation plan from an explicitly identified GitHub Issue."
disable-model-invocation: true
---

# Relay plan

Turn one explicitly identified GitHub Issue into implementation guidance for a later `relay-implement` run. Planning is strictly read-only: inspect the issue and repository, produce the plan, and stop.

Follow `AGENTS.md`, the authoritative repository-wide handbook. This skill narrows it for planning and never relaxes it.

## Establish the issue scope

1. Resolve and read the referenced issue according to `docs/agents/issue-tracker.md`.
2. State the issue number and title before planning.
3. Treat the issue body as the authoritative approved scope. Treat comments as scope changes only when the user explicitly confirms them.
4. If the issue is missing, ambiguous, unreadable, or lacks enough information for a safe plan, report the limitation, mark the plan `BLOCKED` when possible, and stop instead of inventing requirements.

The issue remains authoritative over the plan. Never broaden its product requirements based on implementation details or planner preference. If the issue conflicts with a documented Relay safety invariant or architecture decision, mark the plan `BLOCKED` and identify the conflict for human resolution.

## Inspect repository evidence

Before planning:

1. Run `git status --short --branch` and record human-owned worktree changes without altering them.
2. Read `AGENTS.md`, `docs/agents/domain.md`, and `docs/agents/issue-tracker.md`.
3. Follow `docs/agents/domain.md` to read the Relay documentation relevant to the issue.
4. Inspect enough relevant source, tests, migrations, schema constraints, package scripts, configuration, and surrounding patterns to make the plan concrete.
5. Inspect committed history only when it helps establish current behavior or an existing pattern.

Repository evidence overrides remembered behavior or generic engineering preferences. Stop inspection when every proposed implementation and verification step has concrete repository support.

## Protect sensitive data

- Do not read local secret-bearing files such as `.env`, credential files, tokens, private keys, or similar ignored local configuration.
- Prefer checked-in configuration examples, source code, documentation, and other non-secret repository evidence.
- Redact secrets, credentials, PII, and other sensitive values immediately if they appear during otherwise permitted inspection, and continue permitted read-only inspection only with sanitized evidence.
- Planner output must not include secret values or reproduce other sensitive values. Use a placeholder such as `[REDACTED]` when the existence of a value is relevant to the plan.

## Keep planning read-only

Use only safe, read-only inspection commands. Never:

- Create, modify, delete, rename, or reformat repository files.
- Stage, commit, push, fetch, merge, rebase, switch branches, stash, reset, or clean.
- Create, edit, comment on, label, assign, close, or otherwise mutate GitHub issues or pull requests, or create a pull request.
- Install or update dependencies.
- Run migrations, run database-writing tests, or invoke `npm run verify`.
- Connect to or operate on production, shared, development, or other non-disposable databases.
- Run workers, schedulers, operator mutations, research, reply processing, follow-up processing, reconciliation mutations, or other operational commands.
- Contact Gmail, Google Drive, Firecrawl, OpenAI, or another live provider.
- Enable, set, unset, or modify `RELAY_ENABLE_LIVE_OUTREACH_SEND`.
- Invoke `relay-implement` or `relay-review`, implement changes, remediate findings, create commits, or prepare pull requests.

If a command could write repository state, database state, GitHub state, or external-provider state, omit it from planner execution. It may appear in the later implementation plan only when the issue authorizes the work and the applicable Relay safety rules permit it.

## Classify every conclusion

Label plan conclusions when their source is not self-evident:

- **Required by the issue** — behavior directly stated in the authoritative issue body.
- **Derived from repository evidence** — implementation guidance supported by current files, tests, documentation, schema, configuration, or history.
- **Requires human decision** — unresolved product intent, architecture, recovery behavior, authorization, or safety policy that must not be guessed.

Do not convert an assumption into a requirement. A material unresolved decision makes the plan `BLOCKED`; identify the exact decision and stop at planning.

## Produce the plan

Select exactly one output mode per invocation. Use COMPACT by default, including for human-facing invocations. Select HANDOFF only when the invocation explicitly includes `Output mode: HANDOFF`. Emit only the selected report; never emit both modes.

Both modes use **Plan status** with exactly `READY` or `BLOCKED` and preserve every unresolved human decision, meaningful risk, and safety conflict. Apply the same blocking rules below in either mode.

### COMPACT (default)

Target no more than 200 words. This is a soft target: never omit or truncate blockers, unresolved human decisions, meaningful risks, or safety conflicts to meet it. Use only these seven sections, in order:

1. **Issue**
   - Issue number and title.
2. **Plan status**
   - Exactly `READY` or `BLOCKED`.
3. **Implementation guidance**
4. **Affected files**
5. **Verification**
6. **Human decisions required**
7. **Risks**

Use `None` for Human decisions required or Risks when none exist. Do not repeat the issue body, general repository rules, or standard Relay safety boilerplate. Name an applicable safety conflict when it affects this plan.

Representative COMPACT READY output:

```text
**Issue**: #123 — Add a read-only summary
**Plan status**: READY
**Implementation guidance**: Add the summary using the existing query path.
**Affected files**: src/summary.ts; tests/summary.test.ts
**Verification**: Focused summary test; npm run typecheck.
**Human decisions required**: None
**Risks**: None
```

Representative COMPACT BLOCKED output:

```text
**Issue**: #124 — Choose a retention period
**Plan status**: BLOCKED
**Implementation guidance**: Hold implementation until the retention period is approved.
**Affected files**: None determined.
**Verification**: Determine after the decision.
**Human decisions required**: Approve the retention period; the issue specifies none.
**Risks**: Guessing a period could delete data prematurely.
```

### HANDOFF (explicit `Output mode: HANDOFF` only)

Preserve the complete 12-section handoff contract in this order:

1. **Issue**
   - Issue number and title.
2. **Plan status**
   - Exactly `READY` or `BLOCKED`.
3. **Goal**
4. **Approved scope**
5. **Relevant repository evidence**
   - Concrete file paths, modules, tests, migrations, documentation, and established patterns that informed the plan.
6. **Affected areas**
7. **Implementation steps**
   - Ordered, concrete, implementation-oriented steps.
8. **Verification plan**
   - Focused tests likely needed, `npm run typecheck` expectations, and whether the later implementer should run `npm run verify` at completion.
9. **Relay safety constraints**
   - Applicable fail-closed, idempotency, locking, reconciliation, database, provider, approval, and side-effect boundaries.
10. **Human decisions required**
11. **Out of scope**
12. **Risks and assumptions**

Representative HANDOFF output (each heading is required even when its value is `None`):

```text
**Issue**: #123 — Add a read-only summary
**Plan status**: READY
**Goal**: Show a summary without changing durable state.
**Approved scope**: The issue's read-only summary request.
**Relevant repository evidence**: src/summary.ts; tests/summary.test.ts.
**Affected areas**: src/summary.ts; tests/summary.test.ts.
**Implementation steps**: Add the query-backed summary and focused test.
**Verification plan**: Run the focused test and npm run typecheck.
**Relay safety constraints**: Keep the summary read-only.
**Human decisions required**: None
**Out of scope**: Mutating summary data.
**Risks and assumptions**: None
```

Use `READY` only when the issue and repository evidence let a later implementer proceed without inventing product requirements. Use `BLOCKED` when a material product, architecture, recovery, authorization, or safety decision is unresolved. A blocked plan may record evidence and the exact decision needed, but must not prescribe a guessed implementation.

The authority order is:

```text
GitHub Issue / explicitly approved scope
        ↓
relay-plan guidance
        ↓
actual repository rules and invariants
```

The plan is complete when every section required by the selected mode is present, implementation guidance is supported by issue scope and repository evidence, applicable safety boundaries are respected, and every material uncertainty is either resolved by evidence or listed as a blocking human decision. HANDOFF must name every applicable safety boundary and provide repository-supported affected areas precise enough to derive an exact changed-path allowlist.

## Stop after handoff

Return the selected plan and stop. The user must invoke `relay-implement` separately for implementation and `relay-review` separately for independent review. Neither role depends on trusting planner conclusions; each reads the originating issue and current repository evidence for itself.
