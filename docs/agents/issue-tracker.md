# Relay issue tracker

Relay intends to track specs and implementation work as GitHub Issues in this repository. The `gh` CLI infers the repository from `git remote -v` when run inside a clone.

This document describes how agents use issues. It does not authorize any GitHub write. Follow the Git and GitHub rules in `AGENTS.md`.

## Reading issues and pull requests

Reading is allowed when a task references an issue or pull request:

- **Read an issue**: `gh issue view <number> --json number,title,state,body,labels,comments`.
- **Read a pull request**: `gh pr view <number> --comments`, and `gh pr diff <number>` for its diff.

GitHub shares one number space across issues and pull requests, so a bare `#42` may be either. Resolve it with `gh issue view 42`, falling back to `gh pr view 42`.

When a skill says to fetch the relevant ticket, read it as above and state its title before starting. If the reference is ambiguous or cannot be read, ask the user instead of guessing.

## Intended workflow

1. A human writes or approves an issue that states the scope and acceptance criteria for a change.
2. The user may invoke `relay-plan` to produce read-only, repository-aware implementation guidance.
3. The issue remains the authoritative scope; the plan does not replace it.
4. The user invokes `relay-implement` with that issue as the approved scope.
5. The user invokes `relay-review` independently against a fixed point, and it reads the same issue as the originating scope.

The implementer and reviewer inspect the issue and current repository evidence themselves; neither role depends on trusting planner conclusions.

Alternatively, the user may explicitly invoke `relay-orchestrate` with exactly one issue number. The orchestrator preserves the same authority order while dispatching `relay-plan`, `relay-implement`, and an independent `relay-review` as distinct roles. It alone owns the gated issue branch, fixed commit, push, and pull-request creation. After exact-head CI succeeds, it stops with the PR ready for Taylor's final merge decision; it never merges or enables auto-merge.

Orchestration does not turn planner output into scope. The issue remains authoritative, planner output is advisory to the implementer, and the reviewer reconstructs intent independently from the issue and fixed diff.

The issue body is the approved scope. Comments that change scope count only when the user confirms them.

## Writing to GitHub

Agents never mutate issues or pull requests on their own initiative. Creating, editing, commenting on, labeling, assigning, or closing an issue, and creating, commenting on, or merging a pull request, each require the user to explicitly request that specific action in the current task.

An explicit `relay-orchestrate` invocation authorizes only the workflow mutations documented by that skill: its issue branch, fixed commit, push, and pull-request creation after all gates pass. It does not authorize merge, auto-merge, deployment, manual issue closure, live provider operations, or other GitHub mutations.
