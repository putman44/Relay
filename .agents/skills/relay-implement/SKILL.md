---
name: relay-implement
description: "Implement explicitly approved Relay work from a spec or GitHub issue while preserving Relay's safety, idempotency, reconciliation, and external-side-effect guarantees."
disable-model-invocation: true
---

# Relay implementation

Implement only the scope explicitly approved by the user. Do not add adjacent cleanup, refactors, or enhancements without approval.

Follow `AGENTS.md`, the authoritative repository-wide handbook. This skill narrows it for implementation work and never relaxes it.

## Establish scope and context

- If the user provides a ticket reference, fetch it according to `docs/agents/issue-tracker.md` and state its title before starting. Ask if the reference is ambiguous.
- Before editing, read the relevant Relay code, tests, and documentation.
- Follow `docs/agents/domain.md`: read the Relay documentation it identifies for the area you are changing, use established domain terminology, and surface conflicts with documented decisions.
- Inspect the worktree and relevant diffs before editing. Treat pre-existing uncommitted changes as human-owned work.
- Do not overwrite, discard, reformat, stage, or otherwise alter unrelated work.
- If the approved scope is ambiguous or conflicts with existing human changes, stop and ask before proceeding.

## Safety boundary

Explicit approval means the user approved that specific action for the current task. Do not infer it from available credentials, `.env` contents, configuration, prior approval, or the approved implementation scope itself.

Never do the following, even with approval. They are outside this workflow:

- Operate on a production, shared, or other non-disposable database for any purpose.
- Apply migrations to development, shared, or production environments.
- Enable, set, unset, or change `RELAY_ENABLE_LIVE_OUTREACH_SEND` in any shell, `.env`, process environment, or deployment configuration.
- Perform live operational mutations, such as creating or sending Gmail drafts or messages, writing to Google Drive, running a worker or scheduler, or running an operator mutation.
- Commit, push, create or merge a pull request, or mutate GitHub state, such as creating, editing, commenting on, labeling, or closing an issue or pull request. These remain human or orchestrator responsibilities.

Without explicit task-specific approval, never:

- Run a test that can write to any database. Approved database-writing tests may run only against the guarded local disposable `relay_test` environment described below.
- Invoke any other live Gmail, Google Drive, Firecrawl, OpenAI, or external provider operation.

Never use a production database for tests. Use isolated test resources, mocks, or fixtures.

Migrations:

- Creating or editing migration files under `migrations/` is allowed within the approved implementation scope.
- Applying migrations is allowed only inside an explicitly approved disposable local `relay_test` test workflow.
- Never apply migrations to development, shared, or production environments.

Before running an approved database-writing test, confirm a guarded local disposable `relay_test` configuration:

- `RELAY_TEST_DATABASE_DISPOSABLE=true`.
- `DATABASE_URL` and `RELAY_DRAFT_TEST_DATABASE_URL` both set explicitly for the command to a loopback PostgreSQL database named `relay_test`, not taken from `.env`.
- The `pretest` guard in `scripts/check-test-database.ts` is neither bypassed nor weakened. Focused `npx tsx --test` runs skip `pretest`, so check the same conditions yourself before running them.

If the configuration cannot be confirmed, do not run the test; report it as skipped.

## Implement safely

- Prefer the smallest correct change that satisfies the approved scope.
- Use test-driven development where practical, especially at pre-agreed seams.
- Preserve fail-closed behavior.
- Preserve existing idempotency, transaction, locking, deduplication, and reconciliation guarantees.
- Never weaken authorization, approval gates, feature flags, state-transition checks, audit evidence, or other protections around external side effects.

## Verify the implementation

- Run focused tests during implementation.
- Run typechecking.
- Run the full safe test suite at the end when appropriate for the change and supported by the repository. `npm test` writes to a database, so it needs the approval and configuration above.
- Run only tests confirmed not to use production databases or unapproved live services.
- Never run workers, schedulers, operator mutations, or other state-changing operational commands for verification, and never apply migrations for verification outside an approved disposable `relay_test` test workflow.
- Explicitly report every skipped, unavailable, or incomplete test and the reason.
- If a safety-critical test is skipped or cannot run, treat verification as incomplete and do not describe the implementation as passing.

## Finish with a handoff

Summarize:

- Each changed file and its purpose.
- The test and typecheck commands run, with their results.
- Any skipped tests.
- Any behavior that remains unverified.

Do not commit, push, create or merge a pull request, or mutate GitHub state. These remain human or orchestrator responsibilities.

Do not review your own implementation or invoke a review workflow as part of this skill. Leave review to a separate reviewer agent.
