---
name: relay-orchestrate
description: "Coordinate one explicitly identified Relay GitHub Issue through planning, implementation, fixed-point review, publication, and exact-head CI, then stop for the human merge decision."
disable-model-invocation: true
---

# Relay orchestration

Coordinate one explicitly identified GitHub Issue through Relay's existing engineering roles. The issue body is the authoritative approved scope. This skill is a fail-closed traffic controller: it does not replace `relay-plan`, `relay-implement`, or `relay-review`, and it does not add product authority.

Follow `AGENTS.md`, `docs/agents/issue-tracker.md`, and the safety boundaries of every dispatched skill. Every uncertainty named below is a STOP condition. Report the last completed state and the evidence that caused the stop; do not clean up, guess, substitute, or continue.

## Invocation contract

- Run only when the user explicitly invokes `relay-orchestrate` with exactly one explicit issue number.
- Do not accept a range, list, search result, label, milestone, or natural-language work description in place of the issue number.
- The orchestrator must not poll for issues or select an issue autonomously.
- Resolve the issue according to `docs/agents/issue-tracker.md` and the repository-identity contract below. Require it to be open and readable, state its number and title, and preserve its body as the authoritative approved scope throughout the workflow.
- Treat issue comments as scope changes only when the user explicitly approved them under the existing issue-tracker rules.
- STOP if the issue is missing, closed, ambiguous, unreadable, or insufficient to establish scope.

## Canonical GitHub repository identity

Repository identity is immutable recorded orchestration state, not ambient CLI context:

1. While resolving the issue, run `gh repo view --json nameWithOwner,url` once from the clean starting clone. Require one well-formed `nameWithOwner` and canonical repository URL whose host and owner/name agree. Record the exact `nameWithOwner` as `<canonical-repository>` and the URL host as `<canonical-host>`.
2. Resolve the issue with `gh issue view <issue-number> --repo <canonical-repository> --json number,title,state,body,labels,comments`. Require the returned issue number to equal the requested canonical base-10 number.
3. Record `<canonical-repository>` with the issue number, issue body, base SHA, issue branch, and reviewed HEAD in the recorded orchestration state. Never replace or re-infer it later.
4. Give the planner, implementer, and reviewer the same canonical repository identity. Require any GitHub read they perform to use that identity explicitly.
5. Bind every later `gh` GitHub read or write to `--repo <canonical-repository>`. If `gh api` is needed, use only an endpoint rooted at `/repos/<canonical-repository>/...` and bind the request to `<canonical-host>` explicitly. Never rely on current-directory, remote, or default-host inference after the initial identity capture.

Every Git transport operation must also use the recorded upstream remote only after its fetch and push URLs have been proven to identify `<canonical-repository>` as specified below. If the repository identity, host, URL mapping, issue identity, or explicit binding cannot be proven, STOP before mutation. On any later repository identity mismatch or inability to prove repository identity, STOP immediately.

## Role policy and dispatch

`.agents/relay-orchestration-policy.json` is the single source of truth for orchestration role configuration. Before any repository mutation:

1. Parse it as JSON and require schema version `1`.
2. Validate the schema version and exactly these roles: `planner`, `implementer`, and `reviewer`. Reject missing roles, extra roles, fields, or values.
3. Require each role's exact configured `model` and `reasoningEffort`.
4. Inspect the active runtime's host-provided subagent dispatch capabilities and prove that it supports each exact model and reasoning effort combination.
5. STOP on an unavailable or unsupported role setting, unknown capability, malformed policy, or inability to create a fresh independent context. Do not silently fallback or substitute another model, effort, or role.

Use the active runtime's actual host-provided subagent dispatch mechanism rather than inventing a repository script or API. In Codex, use the available subagent spawning interface and explicitly request the exact model and reasoning effort from the role policy. Require a fresh, independent context for each role.

Do not assume parameter names or capabilities that the active runtime does not expose. If the exact configured model, reasoning effort, or fresh-context semantics cannot be proven, STOP before mutation.

The roles remain distinct:

- `relay-plan` decides whether the issue is ready and produces advisory guidance.
- `relay-implement` makes the approved worktree change without committing or publishing it.
- `relay-review` independently evaluates one committed base/HEAD fixed point without editing it.
- `relay-orchestrate` coordinates handoffs and owns the authorized branch, commit, push, and PR mutations.
- Taylor retains the final merge decision.

## State 1: preflight without mutation

Complete every check before creating or changing a branch, file, commit, or remote state:

1. Run `git status --short --branch` and require an entirely clean worktree: no staged, unstaged, or untracked paths.
2. Require the current branch to be `main`.
3. Resolve local `main` and its configured upstream. Extract and record the upstream remote name without changing refs.
4. Read that remote's configured fetch URLs with `git remote get-url --all <upstream-remote>` and configured push URLs with `git remote get-url --push --all <upstream-remote>`. Require exactly one well-formed fetch URL and exactly one well-formed push URL. Parse only an unambiguous HTTPS, `ssh://`, or SCP-style GitHub URL; require its host to equal `<canonical-host>` and its owner/repository path, after removing at most one terminal `.git`, to equal `<canonical-repository>`. This proves the configured upstream fetch URL and push URL correspond to the canonical repository identity. STOP on multiple URLs, URL rewriting that cannot be inspected, a local/file URL, another host or repository, or any ambiguous form.
5. Query the live remote tip with exactly `git ls-remote --exit-code <upstream-remote> refs/heads/main`. Treat a missing ref, multiple result lines, malformed output, or command failure as ambiguous and STOP.
6. Require local `main`, its configured upstream, and the single live remote `main` SHA returned by that non-mutating query to be identical.
7. Record that exact commit as the base SHA.
8. Confirm the issue, canonical repository identity, and role-policy checks above are complete.

If a check is unavailable or ambiguous, STOP. Never clean, reset, stash, discard, overwrite, reformat, or otherwise alter human-owned work to make preflight pass.

Preflight and planning must remain non-mutating until all preceding gates pass. The first permitted repository mutation is issue-branch creation after the planning gate and the immediate Git-state revalidation below.

## State 2: planning gate

Dispatch a fresh planner context using the configured planner role. Give it the same issue number and explicitly invoke `relay-plan` for the same issue.

Supply `<canonical-repository>` as recorded orchestration state and require every planner GitHub read to bind to it explicitly. A planner-reported repository identity mismatch is a STOP condition.

Require a complete structured plan whose plan status is exactly `READY` and whose human-decisions section contains no unresolved material human decision. STOP on `BLOCKED`, malformed or missing output, unreadable scope, unresolved material human decisions, or a conflict with Relay safety rules.

Retain the planner output for the implementer as advisory context only. The issue remains authoritative.

## Deterministic Git naming contract

Use these algorithms exactly. Render the issue number as canonical base-10 digits without leading zeroes.

For the branch name:

1. Normalize the exact issue title with Unicode NFKD, then lowercase it.
2. Delete all combining marks matching `\p{M}`.
3. Replace every maximal run of characters outside ASCII `[a-z0-9]` with one hyphen.
4. Trim leading and trailing hyphens.
5. Truncate the result to its first 64 ASCII characters, then trim any trailing hyphen created by truncation.
6. STOP if the resulting slug is empty. Otherwise, the branch name is exactly `issue-<issue-number>-<slug>`.

Representative branch outputs are fixed contract examples:

| Issue input | Exact branch output |
| --- | --- |
| `#17`, `feat: add engineering workflow orchestrator` | `issue-17-feat-add-engineering-workflow-orchestrator` |
| `#42`, `Fix Café / CRM sync!!!` | `issue-42-fix-cafe-crm-sync` |
| `#7`, `  API   v2 — retries  ` | `issue-7-api-v2-retries` |

For the commit subject, replace every maximal Unicode whitespace run in the exact issue title with one ASCII space and trim leading and trailing whitespace. STOP if that normalized title is empty. The commit subject template is exactly `<normalized-title> (#<issue-number>)`; do not rewrite its capitalization, punctuation, or conventional-commit prefix.

Representative commit outputs are fixed contract examples:

| Issue input | Exact commit subject |
| --- | --- |
| `#17`, `feat: add engineering workflow orchestrator` | `feat: add engineering workflow orchestrator (#17)` |
| `#42`, `Fix Café / CRM sync!!!` | `Fix Café / CRM sync!!! (#42)` |
| `#7`, `  API   v2 — retries  ` | `API v2 — retries (#7)` |

## State 3: create the issue branch

Only after the planning gate passes:

1. Derive the exact issue branch using the deterministic Git naming contract.
2. Check local and remote refs for that exact name.
3. STOP if the local or remote branch already exists unexpectedly. Never delete, reset, update, or silently reuse a colliding branch.
4. Immediately before creating the issue branch, repeat the complete base proof:
   - Require the current branch to be `main` and the worktree to be entirely clean, with no staged, unstaged, or untracked paths.
   - Require local `main` to equal the recorded base SHA.
   - Re-resolve the configured upstream `main` without changing refs and require it to equal the recorded base SHA.
   - Re-read the configured upstream fetch and push URLs and require both to identify the recorded canonical repository exactly under the State 1 URL rules.
   - Run a fresh non-mutating live-remote query with exactly `git ls-remote --exit-code <upstream-remote> refs/heads/main`. Apply the same single-line, well-formed-result rules as the initial preflight and require live remote `main` to equal the recorded base SHA.
   - If remote `main` advanced or any commit or repository identity differs, STOP. Also STOP on a missing ref, multiple results, malformed output, query failure, or any other ambiguity.
5. Create and switch to the branch from the recorded base SHA.
6. Prove that the current branch is the new issue branch and HEAD is still the recorded base SHA.

Never implement on `main`.

## State 4: implementation

Before dispatch, derive and record an exact expected changed-path allowlist from the issue and the repository-supported affected areas in the accepted plan. Every allowed path must be supported by the authoritative issue. STOP if an exact allowlist cannot be established without guessing.

Dispatch a fresh implementer context using the configured implementer role. Invoke `relay-implement` for the same issue and supply:

- The issue number and authoritative issue body.
- The recorded canonical repository identity, with an instruction to bind every GitHub read to it explicitly.
- The planner output, clearly labeled advisory.
- The recorded base SHA and issue branch.
- The expected changed-path allowlist.

Require the implementer to independently validate the issue, planner guidance, current repository evidence, and safety rules. The implementer must not commit, push, create a pull request, mutate GitHub state, operate live providers, use unsafe databases, or absorb orchestrator authority.

STOP if implementation reports a blocker, broadens scope, leaves ambiguous state, modifies an unexpected path, or violates a `relay-implement` boundary.

Immediately after `relay-implement` returns, and before verification, staging, or committing:

1. Require the current branch to equal the recorded issue branch.
2. Require HEAD to equal the recorded base SHA.
3. Run `git rev-list --count <recorded-base-sha>..HEAD` and require the result to be exactly `0`, proving there are no intervening commits.
4. Inventory staged, unstaged, and untracked paths separately. Require the staged set to be empty because the orchestrator owns staging; require every unstaged and untracked path to be in the expected changed-path allowlist.
5. Inspect the complete worktree and index diff and require every change to be issue-scoped and expected. Do not rely on the implementer report as proof.

Any mismatch must STOP. Do not switch branches, move HEAD, unstage, clean, discard, or otherwise repair the state automatically.

## State 5: pre-commit verification gate

Before committing:

1. Compare the worktree with the recorded base and confirm the diff is issue-scoped.
2. Compare every changed path with the issue and accepted plan; STOP on unexpected worktree paths.
3. Inspect each test and its imports before running it, following `AGENTS.md` database and provider rules.
4. Require all issue-specific verification.
5. Require `npm run typecheck`.
6. Require `npm run verify`, using only its repository-owned disposable Docker database workflow.
7. Record exact commands and results.

Failed, skipped safety-critical, unavailable, or incomplete verification is non-passing and must STOP the workflow. Do not create a commit.

## State 6: fixed implementation commit

When every verification gate passes:

1. Reconfirm the diff is within Issue #<issue-number> scope.
2. Stage only the approved changed paths.
3. Create the exact issue-derived commit subject from the deterministic Git naming contract.
4. Record the base SHA and the resulting implementation HEAD SHA.
5. Require a clean worktree after the commit.
6. Do not push yet.

STOP if staging includes an unexpected path, commit identity is unavailable, the commit fails, HEAD cannot be proven, or the worktree is not clean afterward.

## State 7: independent fixed-point review

Dispatch a fresh independent reviewer context using the configured reviewer role. Do not inherit planner or implementer context. Provide:

- The originating issue as authoritative scope.
- The recorded canonical repository identity, with an instruction to bind every GitHub read to it explicitly.
- The exact recorded base SHA and implementation HEAD SHA as the fixed point.
- Repository instructions and access needed for a read-only `relay-review` run.

Do not provide planner conclusions or implementer self-assessment as authority. Invoke `relay-review` and require the human-readable three-axis report plus its machine-readable review JSON.

Parse the JSON rather than inferring the gate from prose. Continue only when all are true:

- Recommendation is exact `MERGE`.
- Blocking defect count is zero.
- Required verification is exact `SUCCESS`.
- Reviewed base SHA and reviewed HEAD SHA exactly match the recorded base SHA and implementation HEAD SHA.

For `CHANGES`, `FURTHER_DESIGN_REVIEW`, malformed or missing JSON, blockers, incomplete verification, or mismatched SHAs, STOP. This version has no automatic remediation or re-review loop.

## State 8: fixed-point revalidation

Immediately before any push:

1. Require HEAD to equal the exact reviewed HEAD.
2. Require the current branch to equal the recorded issue branch.
3. Require the worktree to remain clean.
4. Require no new commit or modification after review.
5. Revalidate the configured upstream fetch URL and push URL under the State 1 URL rules. Immediately before the push, require the push URL to identify the exact recorded canonical repository and host. Because the push command names `<upstream-remote>` explicitly, this proves its configured push target is the intended repository.
6. Run a fresh non-mutating exact-ref query with exactly `git ls-remote <upstream-remote> refs/heads/<issue-branch>` and require the command to succeed with empty output, proving that the exact remote issue branch still does not exist. Any returned ref is a collision; a command failure, malformed output, or any result whose meaning is uncertain is ambiguous remote state. On any collision or ambiguous remote state, STOP.

Any movement must STOP and requires a new independent review initiated by Taylor. Do not loop automatically.

## State 9: publish the reviewed commit

Only after fixed-point revalidation:

1. Push the exact reviewed commit with this create-only, expected-absence lease and no other refspec: `git push --force-with-lease=refs/heads/<issue-branch>: <upstream-remote> <reviewed-head>:refs/heads/<issue-branch>`. The empty expected object after the lease's final colon is the expected-absence guard: the command must fail if the remote issue branch exists, so the guard cannot advance or overwrite an unexpectedly created remote branch. This is not permission to force-update any existing ref.
2. Open one pull request with `gh pr create --repo <canonical-repository> --base main --head <canonical-repository-owner>:<issue-branch> ...`. The explicit base repository and same-repository head owner are mandatory.
3. Include exactly `Closes #<issue-number>` in the PR body. Because the PR is explicitly created in `<canonical-repository>` and its base repository is validated below, this shorthand refers to the issue in that same canonical repository. Do not use an unverified issue reference from another repository.
4. Query the resulting PR with `gh pr view <pr-number> --repo <canonical-repository> --json number,url,baseRepository,baseRefName,headRepository,headRefName,headRefOid`.
5. Require the PR's base repository identity to equal `<canonical-repository>`, base ref to equal `main`, head repository identity to equal `<canonical-repository>`, head ref to equal the recorded issue branch, and head SHA to equal the reviewed HEAD.
6. Record and report the PR number and URL.

STOP if the expected-absence lease rejects the push, the remote tip is ambiguous, the PR cannot be created, any base or head repository identity or ref mismatches, or the PR head differs from the reviewed HEAD. Never force-update an existing remote ref or accept another commit under the existing review result.

## State 10: exact-head CI gate

Observe the required GitHub check named `verify`. Track pending or in-progress separately from terminal states. A check counts as green only when all existing exact-head rules in `docs/Relay_Testing_and_Worker_Guide.md` are proven:

Every PR, workflow-run, check, or commit-status query in this state must use `--repo <canonical-repository>` (or the explicitly repository-rooted API form from the identity contract). Revalidate the PR's base repository identity, base ref, head repository identity, head ref, and head SHA on every PR refresh; STOP on any mismatch.

1. The PR's current head equals the reviewed HEAD.
2. The workflow run corresponds to that PR revision and workflow revision.
3. The workflow explicitly checks out `github.event.pull_request.head.sha`.
4. The checkout-identity proof passed.
5. The tested head recorded by the workflow equals the reviewed HEAD.
6. The `verify` job succeeded.
7. The run is not missing, stale, cancelled, timed out, superseded, failed, or for an older PR head.
8. Reconfirm the PR head has not changed after CI.

Pending or in-progress is not failure, but it is not green. Wait only within the active user request and runtime limits. A missing or terminal non-green result must STOP with its exact state. Never use a synthetic merge SHA or older-head run as a substitute for the checkout-identity proof.

## Completion boundary

When every gate passes, report exactly this state:

```text
PR ready for human merge
```

Report the canonical repository identity, issue, branch, base SHA, reviewed HEAD SHA, PR number and URL, local verification, review result, and exact-head CI evidence. Then STOP for Taylor's final merge decision.

The orchestrator must not merge, enable auto-merge, deploy, manually close the issue, bypass branch rules, or enable product side effects. It must not add autonomous issue selection or any automatic remediation and re-review loop.
