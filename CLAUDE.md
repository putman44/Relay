# Claude Code Instructions

@AGENTS.md

`AGENTS.md`, imported above, is the authoritative shared engineering handbook for Relay. This file adds only Claude Code compatibility notes.

- Relay skills are available under `.claude/skills/`, which contains relative symlinks to the canonical copies in `.agents/skills/`. Edit skills in `.agents/skills/` only.
- Both Relay skills set `disable-model-invocation: true`. Invoke them explicitly as `/relay-implement` or `/relay-review`.
- Keep personal or machine-specific Claude Code settings in git-ignored local files such as `.claude/settings.local.json` or `CLAUDE.local.md`, not in this file.
