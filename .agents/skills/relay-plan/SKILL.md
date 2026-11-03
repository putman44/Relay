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

Every plan must use these sections in this order:

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

Use `READY` only when the issue and repository evidence let a later implementer proceed without inventing product requirements. Use `BLOCKED` when a material product, architecture, recovery, authorization, or safety decision is unresolved. A blocked plan may record evidence and the exact decision needed, but must not prescribe a guessed implementation.

The authority order is:

```text
GitHub Issue / explicitly approved scope
        ↓
relay-plan guidance
        ↓
actual repository rules and invariants
```

The plan is complete when every required section is present, every implementation step is supported by issue scope and repository evidence, every applicable safety boundary is named, and every material uncertainty is either resolved by evidence or listed as a blocking human decision.

## Stop after handoff

Return the structured plan and stop. The user must invoke `relay-implement` separately for implementation and `relay-review` separately for independent review. Neither role depends on trusting planner conclusions; each reads the originating issue and current repository evidence for itself.
