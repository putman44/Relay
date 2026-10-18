# Relay issue tracker

Relay intends to track specs and implementation work as GitHub Issues in this repository. The `gh` CLI infers the repository from `git remote -v` when run inside a clone.

This document describes how agents use issues. It does not authorize any GitHub write. Follow the Git and GitHub rules in `AGENTS.md`.

## Reading issues and pull requests

Reading is allowed when a task references an issue or pull request:

- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **Read a pull request**: `gh pr view <number> --comments`, and `gh pr diff <number>` for its diff.

GitHub shares one number space across issues and pull requests, so a bare `#42` may be either. Resolve it with `gh issue view 42`, falling back to `gh pr view 42`.

When a skill says to fetch the relevant ticket, read it as above and state its title before starting. If the reference is ambiguous or cannot be read, ask the user instead of guessing.

## Intended workflow

1. A human writes or approves an issue that states the scope and acceptance criteria for a change.
2. The user invokes `relay-implement` with that issue as the approved scope.
3. The user invokes `relay-review` separately against a fixed point, and it reads the same issue as the originating scope.

The issue body is the approved scope. Comments that change scope count only when the user confirms them.

## Writing to GitHub

Agents never mutate issues or pull requests on their own initiative. Creating, editing, commenting on, labeling, assigning, or closing an issue, and creating, commenting on, or merging a pull request, each require the user to explicitly request that specific action in the current task.
