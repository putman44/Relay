---
name: relay-implement
description: "Implement explicitly approved Relay work from a spec or GitHub issue while preserving Relay's safety, idempotency, reconciliation, and external-side-effect guarantees."
---

# Relay implementation

Implement only the scope explicitly approved by the user. Do not add adjacent cleanup, refactors, or enhancements without approval.

## Establish scope and context

- If the user provides a ticket reference, fetch it according to `docs/agents/issue-tracker.md` and state its title before starting. Ask if the reference is ambiguous.
- Before editing, read the relevant Relay code, tests, and documentation.
- Follow `docs/agents/domain.md`: read the relevant glossary and ADRs when present, use established domain terminology, and surface conflicts with existing decisions.
- Inspect the worktree and relevant diffs before editing. Treat pre-existing uncommitted changes as human-owned work.
- Do not overwrite, discard, reformat, stage, or otherwise alter unrelated work.
- If the approved scope is ambiguous or conflicts with existing human changes, stop and ask before proceeding.

## Implement safely

- Prefer the smallest correct change that satisfies the approved scope.
- Use test-driven development where practical, especially at pre-agreed seams.
- Preserve fail-closed behavior.
- Preserve existing idempotency, transaction, locking, deduplication, and reconciliation guarantees.
- Never weaken authorization, approval gates, feature flags, state-transition checks, audit evidence, or other protections around external side effects.
- Never use a production database for tests. Use isolated test resources, mocks, or fixtures.
- Do not invoke live Gmail, Google Drive, Firecrawl, OpenAI, or worker operations unless the user explicitly authorizes that specific live action for the current task.
- Do not infer live authorization from available credentials, configuration, or prior approval.

## Verify the implementation

- Run focused tests during implementation.
- Run typechecking.
- Run the full safe test suite at the end when appropriate for the change and supported by the repository.
- Run only tests confirmed not to use production databases or unapproved live services.
- Explicitly report every skipped, unavailable, or incomplete test and the reason.
- If a safety-critical test is skipped or cannot run, treat verification as incomplete and do not describe the implementation as passing.

## Finish with a handoff

Summarize:

- Each changed file and its purpose.
- The test and typecheck commands run, with their results.
- Any skipped tests.
- Any behavior that remains unverified.

Do not commit, push, or open a pull request.

Do not review your own implementation or invoke a review workflow as part of this skill. Leave review to a separate reviewer agent.
