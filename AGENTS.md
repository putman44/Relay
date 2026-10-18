# Relay engineering handbook

This is the authoritative repository-wide engineering handbook for every coding agent working in Relay, including Codex and Claude Code. Tool-specific files such as `CLAUDE.md` defer to it and add only tool compatibility notes.

Relay replaces Relay-specific n8n workflows with a TypeScript service. Postgres is the authoritative durable state. Gmail, Google Drive, Firecrawl, and OpenAI are external providers whose side effects can be real and irreversible.

## Authorization

Several rules below allow an action only with explicit authorization. Explicit authorization means the user approved that specific action for the current task.

- Never infer authorization from available credentials, `.env` contents, environment variables, configuration, earlier tasks, prior approvals, or other documents.
- Approval of one action does not extend to another action, another environment, or a later task.
- When it is unclear whether an action is authorized, treat it as unauthorized and ask.

## Fail-closed safety

Relay fails closed. When identity, state, a precondition, a provider outcome, or authorization is uncertain, stop and hold the work for a human instead of proceeding.

- A thrown, timed-out, or ambiguous provider call is not proof that the external side effect did not happen. Route uncertain outcomes to reconciliation; never retry them automatically or clear their state.
- Do not weaken a fail-closed state, check, or hold merely to restore liveness or to make a test pass.
- Never weaken authorization, human approval gates, exact-identity confirmations, feature flags, state-transition checks, or audit evidence that protect external side effects.

## Durable-state guarantees

Preserve the existing guarantees of any code you change:

- Idempotency, durable request identity, and duplicate prevention.
- Transaction boundaries.
- Row and advisory locking, and the state rechecks made under those locks.
- Reconciliation states and the audit history they retain.

Recovery reuses existing records and evidence; it does not create replacements or erase history. The current invariants are listed in `docs/Relay_Testing_and_Worker_Guide.md` (section 15) and `docs/Relay_Production_Operations_Runbook.md` (section 1).

## Worktree ownership

Treat every pre-existing uncommitted change, whether staged, unstaged, or untracked, as human-owned.

- Never discard, overwrite, reformat, stage, stash, reset, clean, or otherwise alter human-owned changes.
- If human-owned changes conflict with the task, stop and ask.
- If a command unexpectedly changes the worktree, stop and report the exact change instead of cleaning it up.

## Databases

- **No production database operations.** Do not connect to, query, or write a production database without explicit authorization for that specific operation, and never apply migrations to one. Never use a production or other non-disposable database for tests or verification. `src/db.ts` loads `.env` through `dotenv`, so `DATABASE_URL` may point at a remote production database by default.
- **No database-writing tests without approval.** A test that can write to any database requires explicit user approval and may run only against the guarded local disposable `relay_test` environment:
  - `RELAY_TEST_DATABASE_DISPOSABLE=true`.
  - `DATABASE_URL` and `RELAY_DRAFT_TEST_DATABASE_URL` both set explicitly for the command to a loopback (`localhost`, `127.0.0.1`, or `[::1]`) PostgreSQL database named `relay_test`. Do not rely on `.env` for these values.
  - `npm test` enforces this through the `pretest` guard in `scripts/check-test-database.ts`. Do not bypass or weaken that guard. Focused `npx tsx --test` runs do not execute `pretest`, so confirm the same configuration yourself before running any test file that can reach a database.
- Many tests import `src/db.ts` and write through `DATABASE_URL`; the newer integration tests write through `RELAY_DRAFT_TEST_DATABASE_URL`. Treat both as database-writing tests.
- **Migrations.** Creating or editing migration files under `migrations/` is allowed within approved implementation scope. Applying migrations is allowed only inside an explicitly approved disposable local `relay_test` test workflow. Never apply migrations to development, shared, or production environments.

## External effects and operational commands

- Do not perform live Gmail, Google Drive, Firecrawl, or OpenAI operations, run workers or schedulers, or run operator mutations without explicit authorization for that specific action.
- Do not set or enable live-send flags, such as `RELAY_ENABLE_LIVE_OUTREACH_SEND`, in a shell, `.env`, process environment, or deployment configuration without explicit authorization for that specific action. Verification never requires them.
- Do not run migrations or other state-changing operational commands merely for verification. Every `npm run` script other than `typecheck` and `test`, and every operational entry point under `scripts/`, operates against the configured database or live providers. Examples include `prospect:add`, `draft:outreach`, `worker:outreach`, `monitor:outreach`, `monitor:replies`, `reply:process`, `follow-up`, `research`, `outreach:operator`, and `scripts/run-migration.ts`; these examples are not exhaustive. Approved database-writing tests that apply migrations inside their own disposable `relay_test` schema are not operational commands.

## Git and GitHub

- Reading issues and pull requests is allowed as described in `docs/agents/issue-tracker.md`.
- Do not commit, push, merge, create pull requests, or mutate issues or pull requests (create, edit, comment, label, assign, or close) unless the user explicitly requests that specific action.

## Verification

- Run `npm run typecheck` for code changes.
- Before running a test, inspect it and its imports for database, provider, worker, scheduler, and environment use. Run only tests confirmed not to reach a production database or an unauthorized live service.
- Prefer focused tests during development: `npx tsx --test tests/<domain>/<file>.test.ts`.
- Report every skipped, unavailable, or incomplete test and the reason. If a safety-critical test cannot run, verification is incomplete; do not describe the change as passing.

## Relay documentation

- Domain and operational context: `docs/agents/domain.md`.
- Issue workflow: `docs/agents/issue-tracker.md`.

## Relay skills

Canonical skill definitions live in `.agents/skills/`. `.claude/skills/` holds relative symlinks to them for Claude Code; do not copy or duplicate `SKILL.md` files.

- Route implementation work to `relay-implement`.
- Route independent review work to `relay-review`. An implementing agent does not review its own work.

### `relay-implement` limits

`relay-implement` is held to stricter limits than the rest of this handbook. It never does the following, even with approval:

- Operate on a production, shared, or other non-disposable database.
- Apply migrations to development, shared, or production environments.
- Enable, set, unset, or change `RELAY_ENABLE_LIVE_OUTREACH_SEND` in any shell, `.env`, process environment, or deployment configuration.
- Perform live operational mutations, such as creating or sending Gmail drafts or messages, writing to Google Drive, running a worker or scheduler, or running an operator mutation.
- Commit, push, create or merge pull requests, or mutate GitHub state. These remain human or orchestrator responsibilities.

Database-writing tests under `relay-implement` still require explicit approval and may run only against the guarded local disposable `relay_test` environment.

Relay skills are explicit workflows. Run one only when the user invokes it; never select one implicitly. Codex enforces this with `policy.allow_implicit_invocation: false` in each skill's `agents/openai.yaml`, and Claude Code with `disable-model-invocation: true` in each `SKILL.md` frontmatter. If a request fits a Relay skill that the user did not invoke, name the skill so the user can invoke it.
