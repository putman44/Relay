---
name: relay-review
description: "Perform a read-only review of Relay changes since a user-supplied fixed point across Spec, Relay Safety, and Standards. Use only when explicitly invoked; never fix findings or modify repository or remote state."
---

# Relay review

Review the committed diff between `HEAD` and a fixed point supplied by the user, such as `main`, a tag, or a commit SHA.

Run three independent review axes:

- **Spec**
- **Relay Safety**
- **Standards**

Keep their reasoning separate so success on one axis cannot mask a failure on another.

## Read-only boundary

This skill is strictly read-only.

Never:

- Modify, create, delete, rename, or reformat files.
- Fix a finding.
- Generate or update snapshots, fixtures, migrations, coverage output, or lockfiles.
- Install or update dependencies.
- Stage, commit, push, fetch, merge, rebase, switch branches, stash, reset, or clean.
- Create, update, comment on, or close an issue or pull request.
- Open a pull request.
- Run a worker, scheduler, operator mutation, migration, or application command with external side effects.
- Enable `RELAY_ENABLE_LIVE_OUTREACH_SEND`.
- Invoke live Gmail, Google Drive, Firecrawl, OpenAI, or other external provider operations.
- Use a production database.

Read-only GitHub operations may be used to obtain an originating issue or pull-request description according to `docs/agents/issue-tracker.md`.

Treat every pre-existing worktree change as human-owned. Do not alter it for any reason. If verification unexpectedly changes the worktree, stop, report the exact change, and do not clean it up.

Do not expose secrets or PII in the report. Redact credentials, OAuth material, email content, addresses, provider payloads, and sensitive database values.

## Establish the review target

Before reviewing:

1. Run `git status --short --branch`.
2. Record all staged, unstaged, and untracked paths.
3. Require the user to supply the fixed point. Do not choose one implicitly.
4. Resolve it locally with `git rev-parse --verify <fixed-point>^{commit}`.
5. Record the merge base with `git merge-base <fixed-point> HEAD`.
6. Inspect:
   - `git diff --stat <fixed-point>...HEAD`
   - `git diff --name-status <fixed-point>...HEAD`
   - `git diff <fixed-point>...HEAD`
   - `git log --oneline --decorate <fixed-point>..HEAD`
7. Inspect relevant commits individually when their intent or history matters.

Do not fetch to resolve a missing or stale ref. Ask the user for a locally available fixed point or separate authorization outside this skill.

The three-dot diff covers committed changes through `HEAD`. Do not silently include human-owned working-tree changes. Report relevant uncommitted changes as excluded unless the user explicitly places them in review scope.

If the fixed point does not resolve or the committed diff is empty, stop and report that condition rather than fabricating a review.

## Locate the originating scope

Determine what the change was approved to implement.

Look in this order:

1. A spec, plan, issue, or scope statement supplied by the user.
2. GitHub issue or pull-request references in the relevant commit messages.
3. The pull-request description when the user identified a pull request.
4. Matching plans or specifications under repository documentation.
5. Relevant approved scope recorded in nearby implementation documentation.

Follow `docs/agents/issue-tracker.md` when reading GitHub issues. Reading is allowed; writing is not.

If no authoritative scope can be found, ask the user for it. If the user confirms that no spec exists, continue the other axes and report the Spec axis as not verifiable. Do not infer requirements solely from the implementation.

When sources conflict, report the conflict and identify which source appears authoritative. Do not silently choose a broader scope.

## Read Relay context

Before assessing the diff:

- Read all applicable `AGENTS.md` instructions.
- Follow `docs/agents/domain.md`.
- Read the relevant glossary and ADRs when present.
- Read documented repository standards and configuration relevant to the changed files.
- Read surrounding implementation code, not only changed hunks.
- Read relevant migrations, schema constraints, tests, fixtures, and provider boundaries.
- Read the relevant portions of:
  - `docs/Relay_Migration_Plan.md`
  - `docs/Relay_Testing_and_Worker_Guide.md`
  - `docs/Relay_Production_Operations_Runbook.md`
- Inspect package scripts before running any verification command.

Prefer current repository evidence over remembered behavior or generic best practices.

## Independent review passes

When sub-agent delegation is available, run the three axes as separate parallel reviewers. Give each reviewer the same evidence packet, but do not give it another axis's conclusions.

The shared evidence packet must include:

- The fixed point and resolved SHA.
- The merge base.
- The exact diff command.
- The commit list.
- The originating scope or its absence.
- The changed-file list.
- Relevant repository instructions and documentation.
- Relevant surrounding code, tests, migrations, and schema evidence.
- Worktree paths excluded from review.
- The full read-only and external-side-effect boundaries from this skill.

Every delegated reviewer inherits the read-only boundary and must not fix its findings.

If delegation is unavailable, perform three clearly separated passes. Do not use conclusions from one pass as evidence for another.

## Axis 1: Spec

Compare the implementation with the originating issue, plan, or approved scope.

Find:

- Missing requirements.
- Partially implemented requirements.
- Behavior that contradicts the approved requirement.
- Implementations that appear present but are incorrect or incomplete.
- Unsupported assumptions.
- Scope creep, unrelated cleanup, or unapproved behavior.
- Tests or documentation required by the scope but omitted.
- Acceptance criteria that cannot be demonstrated.

Cite the exact requirement for each finding. If the requirement is ambiguous, record a design question rather than a confirmed defect.

Do not treat implementation behavior as proof of intended behavior.

## Axis 2: Relay Safety

Review both happy paths and failure paths. Trace retry and recovery behavior through interruption, provider uncertainty, process crashes, and database failures.

For each changed workflow, trace where applicable:

1. Durable request or operation identity.
2. Reservation and duplicate prevention.
3. Database transaction boundaries.
4. Row or advisory locking.
5. State and precondition rechecks.
6. External-provider invocation.
7. Provider response validation.
8. Durable finalization.
9. Failure after an external side effect but before finalization.
10. Retry classification.
11. Reconciliation state.
12. Human approval or confirmation required for recovery.
13. Behavior after process interruption and restart.

Focus especially on:

- Fail-closed behavior.
- Idempotency and duplicate prevention.
- Durable request identity.
- Transaction and locking behavior.
- Race conditions and stale reads.
- Recovery after interruption or crash.
- Retry eligibility and retry exhaustion.
- Reconciliation states and retained audit evidence.
- Gmail, Drive, Firecrawl, OpenAI, and other external side effects.
- Ambiguous provider outcomes.
- Approval, confirmation, feature-flag, and authorization boundaries.
- Production database safety.
- Test isolation.
- Skipped or weakened safety-critical tests.
- Secrets and PII exposure in logs, errors, fixtures, or reports.
- Unsafe, impossible, or insufficiently guarded state transitions.
- Migrations and schema constraints required to enforce invariants.
- Differences between application checks and database-enforced guarantees.

A thrown or timed-out provider call is not proof that the external side effect did not happen. Flag automatic retry or state clearing after an uncertain outcome when it could duplicate an external mutation.

Do not recommend weakening a fail-closed state merely to restore liveness.

## Axis 3: Standards

Identify the concrete repository rules governing the changed code.

Check, as relevant:

- `AGENTS.md`.
- `docs/agents/`.
- Relevant glossary and ADR files.
- `CONTRIBUTING.md`, coding-standard documents, and local module guidance.
- TypeScript, package, test, and formatting configuration.
- Documented architectural and operational conventions.
- Established patterns in the directly surrounding code when no written rule exists.

Repository documentation overrides generic preferences.

Report generic code smells only when they materially affect correctness, safety, or maintainability. Do not report subjective formatting, naming, abstraction, or refactoring opinions that tooling already enforces or that have no concrete consequence.

Cite the repository rule or surrounding established pattern for each Standards finding.

## Verification

Verification remains read-only and fail-closed.

Run `npm run typecheck` when relevant unless the change is clearly documentation-only or the command is unavailable. Report the reason for any skip.

Run focused tests only after inspecting the test, its setup, imported runtime boundaries, environment use, and expected outputs. Confirm that the command:

- Uses fakes, mocks, fixtures, or disposable resources.
- Cannot contact live providers.
- Cannot use a production database.
- Does not invoke a worker or scheduler.
- Does not modify repository files.

A test that can write to any database or contact an external service requires explicit user approval before execution. Approval never permits using a production database or making a live external mutation.

For focused tests known to be isolated, use the narrowest applicable test command. Do not bypass a required database-safety check merely to run fewer tests.

Run the full safe suite when the change affects shared persistence, migrations, state machines, provider adapters, job processing, approval boundaries, recovery, or other cross-cutting behavior, and only after confirming its pretest guard and environment are safe. The presence of a guard does not replace required user approval for database-affecting tests.

Never run scripts such as workers, research commands, draft creation, reply processing, follow-up processing, reconciliation mutations, or operator mutations as verification.

Record every command exactly, including its exit result. Distinguish:

- Passed.
- Failed because of the code.
- Failed because of the environment.
- Skipped as unsafe.
- Skipped because approval was not provided.
- Not applicable.

Explicitly report all skipped tests. If a safety-critical test is skipped, unavailable, or cannot safely run, verification is incomplete and the final recommendation cannot be **merge**.

After verification, run `git status --short --branch` again. Report any difference from the initial status and do not modify it.

## Finding requirements

Classify each item as exactly one of:

- **Confirmed defect**: repository evidence demonstrates a reachable incorrect or unsafe behavior.
- **Design question**: intent or the correct safety boundary is unresolved.
- **Hardening suggestion**: no present defect is demonstrated, but a concrete resilience improvement is justified.

Do not present a design question or hardening suggestion as a confirmed bug.

For every finding provide:

- **Severity:** critical / high / medium / low
- **Review axis:** Spec / Relay Safety / Standards
- **Classification:** confirmed defect / design question / hardening suggestion
- **Location:** file and line, range, or function
- **Concrete failure scenario:** the inputs and sequence that trigger the concern
- **Evidence:** relevant code plus the governing spec, invariant, test, schema, or repository rule
- **Existing tests:** whether current tests catch it, with test paths; use yes / no / partial / not run
- **Recommended remediation:** the smallest safe direction, without implementing it
- **Confidence:** high / medium / low

Severity describes impact if the concern is real. Confidence describes the strength of the evidence; do not use low confidence as a substitute for design-question classification.

Avoid findings based only on hypothetical possibilities. Demonstrate a reachable path or clearly identify the missing evidence.

## Final report

Keep the three axes visibly separate. Do not let a clean Standards result offset a Spec or Relay Safety failure.

Report:

1. Findings ordered by severity within each axis.
2. A summary count by severity and review axis.
3. Exact commands and tests run with results.
4. Skipped tests and why they were skipped.
5. Safety-critical verification that remains incomplete.
6. Files, behavior, environments, or live integrations not verified.
7. Excluded human-owned working-tree changes.
8. One recommendation:
   - **Merge**: no confirmed defects or unresolved safety/design blockers, and appropriate verification completed.
   - **Changes**: confirmed defects or missing approved requirements require implementation changes.
   - **Further design review**: intent, recovery semantics, or a safety boundary remains unresolved, or safety-critical verification is incomplete.

If there are no findings, say so directly but still report residual verification limits. Do not claim that live or production behavior is verified unless it was directly and safely established within the user's authorization.
