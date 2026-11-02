# Relay Agent Engineering Learning Notes

_Last updated: October 18, 2026_

This notebook captures the agentic engineering concepts, workflow patterns, Relay-specific decisions, Git practices, and lessons learned while building the Relay engineering workflow.

---

## 1. Core Mental Model

### Agent
An **agent** is the worker or role doing a job.

Examples:
- Lead / Planner
- Implementer
- Reviewer
- QA / Test Agent
- Documentation / Handoff Agent

A useful shorthand:

> **Agent = role + context + tools + permissions + workflow**

### Skill
A **skill** is a reusable playbook or procedure that an agent follows.

Examples in Relay:
- `relay-implement`
- `relay-review`

Generic third-party skills were useful as learning references, but Relay ultimately removed the generic `implement`, `code-review`, `handoff`, and setup skills from the repository. They overlapped with Relay's purpose-built workflows and created ambiguity around safety, database access, committing, and review boundaries.

A useful shorthand:

> **Agent = who does the work**  
> **Skill = how the work is done**

### AGENTS.md
`AGENTS.md` is the project's engineering handbook for AI coding tools.

It should contain durable repository-wide instructions and boundaries that should apply repeatedly.

### GitHub Issue
A GitHub Issue is the durable **work order**.

It should eventually carry:
- problem
- scope
- requirements
- acceptance criteria
- safety notes
- links to related code / PRs

### Orchestrator / Lead Agent
The orchestrator acts like an engineering manager.

It should eventually:
- read the ticket
- decide which specialist is needed
- route work to the Implementer
- send the result to the Reviewer
- route failures back for revision
- ask QA to verify
- surface the final decision to the human

---

## 2. Where We Are Today

We have **not yet built a fully autonomous multi-agent team**.

The current architecture is:

```text
Taylor
  ↓
Codex or Claude Code
  ↓
explicit Relay skill
  ├── relay-implement
  └── relay-review
```

The coding model/tool is the active worker, while the Relay skills are specialized operating procedures. The canonical skills live under `.agents/skills/`; Claude Code reaches the same project-local skills through relative links under `.claude/skills/`.

As of October 18, 2026, this agent infrastructure is merged into `main`. The same Relay implementation and review model has now been exercised with both Codex and Claude Code, while keeping the human in control of scope, risky actions, Git publication, and final merge decisions.

This is deliberate. We are validating the workflows before automating orchestration.

---

## 3. The Professional Workflow We Are Moving Toward

A normal software engineering workflow already looks like:

```text
ticket
  ↓
developer
  ↓
branch
  ↓
implementation
  ↓
review
  ↓
tests / CI
  ↓
PR
  ↓
merge
```

The agentic version becomes:

```text
GitHub Issue
     ↓
Lead Agent
     ↓
Implementer Agent
     ↓
Reviewer Agent
     ↓
QA Agent
     ↓
Pull Request
     ↓
Taylor approves merge
```

The important idea is that agent engineering is still software engineering underneath.

The difference is that some team roles are performed by AI agents.

---

## 4. How This Maps to Jira

Relay's future GitHub Issues workflow is conceptually similar to the Jira workflow used by software teams.

```text
Jira                         GitHub
----                         ------
Ticket                       Issue
Story / bug                  Story / bug
Requirements                 Requirements
Acceptance criteria          Acceptance criteria
Status                       Issue / PR status
Developer                    Human or agent
Branch                       Branch
Code review                  PR / Reviewer Agent
Testing                      QA / CI
Done                         Merged / closed
```

This is useful because the work-management pattern is already familiar.

---

## 5. Matt Pocock Skill Workflow

The general approach we are borrowing is roughly:

```text
install reusable skills
      ↓
explore / grill the problem
      ↓
create a spec
      ↓
break spec into tickets
      ↓
implement one ticket
      ↓
independent review
      ↓
iterate
      ↓
retro / improve system
```

We are following the philosophy, but adapting it for Relay rather than blindly copying everything.

### What we adopted
- reusable skills
- implementation playbooks
- separate code review
- repository context
- handoff concepts
- narrow specialist roles
- independent review

### What we changed for Relay
Matt's generic implementation workflow was too permissive for our needs.

For Relay we intentionally:
- do **not** automatically commit
- do **not** automatically push
- keep Reviewer independent from Implementer
- preserve human-owned uncommitted work
- require explicit authorization for risky live actions
- protect production databases
- treat skipped safety-critical tests as incomplete verification
- emphasize crash recovery, idempotency, and external side effects

---

## 6. Relay Agent Infrastructure We Built

Current agent-related repository structure:

```text
AGENTS.md

docs/agents/
├── domain.md
└── issue-tracker.md

.agents/skills/
├── implement/                 # Matt
├── code-review/               # Matt
├── handoff/                   # Matt
├── setup-matt-pocock-skills/  # Matt
├── relay-implement/           # Relay-specific
└── relay-review/              # Relay-specific

skills-lock.json
```

### relay-implement
Purpose:

> Safely implement only explicitly approved Relay work.

Key behavior:
- inspect current repo state
- preserve pre-existing human work
- implement the smallest approved change
- preserve fail-closed behavior
- preserve idempotency / locking / reconciliation
- do not touch live services without explicit authorization
- never use production DBs for tests
- run safe verification
- report a handoff
- do not commit / push / PR automatically
- do not review its own work

### relay-review
Purpose:

> Perform an independent, read-only review of Relay changes.

Three separate review axes:

1. **Spec**
2. **Relay Safety**
3. **Standards**

Key Relay Safety concerns:
- fail-closed behavior
- idempotency
- duplicate prevention
- durable request identity
- transactions
- locks
- retry behavior
- reconciliation
- crash recovery
- external side effects
- Gmail / Drive / Firecrawl / OpenAI boundaries
- production database safety
- skipped safety-critical tests
- secrets / PII
- unsafe state transitions

---

## 7. Why Separate Implementer and Reviewer

A strong review should not depend on the Implementer's explanation.

The Reviewer should be able to reconstruct intent from:

```text
issue / spec
+
repo
+
diff
+
tests
+
project rules
```

This is stronger than asking:

> "Does the Implementer's explanation sound convincing?"

Instead, the Reviewer asks:

> "Does the implementation actually satisfy the requirement?"

That independence is one of the most important parts of the workflow.

---

## 8. First Real Agentic Engineering Loop

We used the new workflow on the prospect-intake integration test safety problem.

The initial goal:

> Make prospect-intake and prospect-research database integration tests fail closed rather than silently skip.

### Implementer result
The Implementer reported:
- focused tests passed
- typecheck passed
- full suite passed
- zero skipped tests
- no live services touched

### Reviewer result
The independent Reviewer found a serious issue.

A connection string like:

```text
postgresql://relaytest@127.0.0.1:55439/relay_test?host=remote.neon.tech
```

could appear local to a simple URL check because the URL authority is:

```text
127.0.0.1
```

but PostgreSQL's effective connection parsing could honor:

```text
host=remote.neon.tech
```

That meant a supposedly local test configuration could actually route to a remote database.

The Reviewer correctly classified this as a merge-blocking Relay Safety defect.

### Why this mattered
The test code could:
- create schemas
- apply migrations
- write test data
- drop schemas

So this was exactly the kind of bug the safety review was designed to catch.

### Remediation
The Implementer then updated the guard to validate the **effective PostgreSQL connection target**, not only the raw URL authority.

Regression coverage was added for the routing override.

### Human approval boundary
Before running real database-writing verification, the Implementer stopped and required explicit approval.

Taylor authorized only:
- loopback/local database
- database name `relay_test`
- `RELAY_TEST_DATABASE_DISPOSABLE=true`
- guard must pass first
- no live providers
- no production data

Verification then succeeded:

```text
Focused tests: 17 passed, 0 skipped
Full suite:    282 passed, 0 skipped
Typecheck:     passed
git diff check: passed
```

This was the first complete example of the system working as intended:

```text
Implement
   ↓
Independent Review
   ↓
Reviewer finds real defect
   ↓
Implement remediation
   ↓
Human authorizes risky verification
   ↓
Verify
   ↓
Review entire solution
```

---

## 9. Major Lesson From the Database Bug

The most important pattern:

```text
bug
 ↓
lesson
 ↓
rule
 ↓
skill / test / repo instruction
 ↓
future agents catch it earlier
```

This is how an agent system improves over time.

For example:

**Failure:**
A green test suite could still skip important integration tests.

**Lesson:**
Safety-critical skipped tests are not a passing verification.

**Durable rule:**
If safety-critical tests are skipped, verification is incomplete.

Another example:

**Failure:**
A raw URL looked local while the driver could route remotely.

**Lesson:**
Safety checks should validate effective driver semantics, not just surface syntax.

**Durable improvement:**
Regression test + stronger test DB guard.

---

## 10. Prompt Writing Mental Model

Strong agent prompts are not about clever wording.

They come from turning engineering judgment into a checklist.

Use:

```text
Role
+
Goal
+
Scope
+
Inputs
+
Rules
+
Failure modes
+
Verification
+
Output format
```

Starter template:

```text
You are acting as [ROLE].

Goal:
[what success means]

Scope:
[exact task]

Read:
[issue/spec/files/diff/docs]

Pay special attention to:
[known failure modes]

Do not:
[forbidden actions]

Verify:
[tests/checks]

Report:
[required output]

Stop and ask if:
[ambiguity / permission boundary]
```

A useful question to ask:

> If I hired a new engineer for this role, what would I tell them so they don't make a dangerous mistake?

Write that down.

That becomes the prompt or skill.

---

## 11. Why Prompts Will Get Shorter

Today we still write prompts like:

```text
Use relay-implement.

Implement only this change...

Requirements:
- ...
- ...

Do not...
Verify...
```

Eventually the work should be split across durable sources.

### AGENTS.md
Contains:

> How engineers must behave in this repo.

### Skill
Contains:

> How to perform this type of job.

### GitHub Issue
Contains:

> What exact work should be done.

So an eventual prompt can become:

```text
Use relay-implement on GitHub issue #42.
```

The Reviewer can become:

```text
Use relay-review.
Fixed point: <commit>
Scope: GitHub issue #42.
```

And eventually the Lead Agent can generate those handoffs automatically.

---

## 12. GitHub Issues as Work Orders

A future Relay ticket might look like:

```text
Title:
Make prospect DB tests fail closed

Problem:
The intake and research suites can silently skip when
the validated DB environment is unavailable.

Requirements:
- keep pretest guard
- use only local disposable relay_test
- remote DBs prohibited
- focused runs enforce same guard
- no silent skips

Acceptance criteria:
- focused suites execute
- invalid configuration fails before DB writes
- full safe suite passes
```

Then:

```text
GitHub Issue
   ↓
Implementer
   ↓
Reviewer
   ↓
QA
   ↓
PR
```

This removes a large amount of manual copy/paste.

---

## 13. Model Selection for Future Agents

Do not automatically use the strongest model for every job.

Choose based on:

- complexity
- risk
- latency
- cost
- frequency

### Strong reasoning tier
Best for:
- Lead / Architect
- Reviewer
- architecture decisions
- safety-critical behavior
- ambiguous requirements
- recovery / idempotency analysis

### Faster / cheaper tier
Good for:
- test execution
- formatting handoffs
- summarizing logs
- documentation
- routine deterministic tasks
- simple implementation from a clear spec

Useful rule:

> Use the least expensive model that can reliably perform the job.

A future Lead Agent can route tasks to different model tiers automatically.

---

## 14. Why Narrow Agents Are Better

Avoid the "mega agent."

Prefer specialists:

```text
Lead
├── Implementer
├── Reviewer
├── QA
└── Docs / Handoff
```

Each role should have:
- narrow responsibility
- clear permissions
- explicit inputs
- explicit outputs
- clean context

This reduces context rot and makes failures easier to diagnose.

---

## 15. Current Workspaces and Their Purpose

### Relay_chat
Use for:
- learning
- architecture discussions
- planning
- understanding concepts
- reviewing lessons
- maintaining this notebook

### Relay_Local_Work
Use for:
- Codex / Work execution sessions
- implementation
- code review
- test / verification sessions

### Relay Git repository
Use for:
- source code
- tests
- migrations
- `AGENTS.md`
- agent skills
- engineering documentation

### GitHub
Use for:
- durable issues
- branches
- commits
- pull requests
- future work tracking

A clean mental model:

```text
Relay_chat
= engineering discussion + learning

Relay_Local_Work
= AI engineering execution

GitHub
= durable work management

Relay repo
= code + engineering rules
```

---

## 16. Useful Git Lessons From This Session

### Commit with a message

```bash
git commit -m "message"
```

Using `-m` avoids opening a text editor.

### Why Vim appeared
A merge needed a commit message and Git had no `-m` argument, so it opened its configured/default terminal editor.

### Configure VS Code as Git editor

```bash
git config --global core.editor "code --wait"
git config --global sequence.editor "code --wait"
```

Verify:

```bash
git config --global --get core.editor
git config --global --get sequence.editor
```

Expected:

```text
code --wait
code --wait
```

### Useful Vim escape knowledge
Save and exit:

```text
Esc
:wq
Enter
```

Quit without saving:

```text
Esc
:q!
Enter
```

---

## 17. Branching, Rebase, and Worktree Lesson

Agent infrastructure was developed on its own branch:

```text
chore/agent-skills-setup
```

The prospect-intake product work was kept separate and merged first. The tooling branch was later rebased onto the newer `main`, reviewed again, pushed with `--force-with-lease`, and merged through its own pull request.

A key distinction:

```text
branch   = a line / pointer in Git history
worktree = a physical folder where a branch is checked out
```

A separate worktree let Relay keep the normal product checkout on `main` while the tooling branch stayed open in another folder:

```text
Relay/             → main
Relay-agent-tools/ → chore/agent-skills-setup
```

Branches are what get merged. Worktrees are temporary working folders and can be removed after the branch is safely merged.

This is a strong pattern for infrastructure work, hotfixes, or future parallel agent work because it avoids constantly switching one folder between branches.

---

## 18. Human Approval Boundaries

Relay should keep a human in control of risky actions.

Examples that should require explicit authorization:
- production database access
- database-writing tests when safety is not already proven
- live Gmail actions
- live Drive mutations
- Firecrawl usage when external impact matters
- OpenAI calls with cost / side-effect implications
- workers / schedulers
- deployment
- merge / push policies where appropriate

The goal is not:

```text
AI writes
→ AI reviews
→ AI merges
→ AI deploys
```

with no human involvement.

A healthier Relay model:

```text
AI does repetitive engineering work
AI challenges AI work
Tests prove as much as possible

Taylor controls:
- scope
- architecture decisions
- dangerous live actions
- production
- final merge
```

---

## 19. What We Should Build Next

Do not rush into a giant orchestration framework.

Recommended progression:

### Stage 1 — Current
```text
Taylor
→ Codex or Claude Code
→ explicit Relay skill
```

The shared Relay skills are now repository-local and merged into `main`; the current learning goal is to make the manual workflow reliable before adding orchestration.

### Stage 2 — Better work orders
```text
GitHub Issues
→ relay-implement
→ relay-review
```

### Stage 3 — Specialized persistent agents
```text
Lead
Implementer
Reviewer
QA
```

### Stage 4 — Orchestration
```text
Taylor gives a goal
     ↓
Lead decomposes it
     ↓
Implementer
     ↓
Reviewer
     ↓
QA
     ↓
Lead handles revisions
     ↓
Taylor approves
```

### Stage 5 — More autonomy
Only after:
- workflows are stable
- permissions are clear
- tests are reliable
- failure modes are understood
- human approval boundaries are proven

---

## 20. Relay Prospect-Intake Remediation — Completed

The earlier prospect-intake remediation plan was completed and merged into `main` on October 18, 2026.

Completed work:

1. DB integration-test checks were made fail-closed instead of silently skipping.
2. Duplicate intake now returns only the durable, authoritative request ID.
3. The no-Gmail safe-research policy is persisted so restart / retry behavior remains safe.
4. Migration, testing, and operations documentation was updated.
5. Research status exposes the durable Gmail policy and malformed JSON errors no longer echo submitted content.
6. Firecrawl source validation and apex / `www` crawl behavior were tightened and covered by tests.

Final branch verification reached **289/289 tests passed, 0 failed, 0 skipped**, plus a passing typecheck and read-only branch review before the pull request was squash-merged.

Still separate from the completed implementation are production-policy decisions around legacy prospect website identity and whether intake should treat apex / `www` hosts as equivalent. These are rollout/design questions, not blockers to the merged implementation.

Important rule retained from this work:

> Do one remediation at a time, independently review it, then move to the next.

---

## 21. A Practical Definition of "Agentic Engineering"

Agentic engineering is not simply:

> "AI writes code."

It is closer to:

> Build a software engineering system in which specialized AI workers operate under explicit roles, durable project context, narrow permissions, repeatable skills, testable handoffs, and human-controlled safety boundaries.

The quality comes from the **system around the model**, not just the model itself.

---

## 22. Key Ideas Worth Remembering

- Agent = worker.
- Skill = playbook.
- `AGENTS.md` = project handbook.
- GitHub Issue = work order.
- Orchestrator = engineering manager.
- Tests = evidence.
- Reviewer should be independent.
- Important knowledge should not live only in chat history.
- Narrow roles beat mega-agents.
- Fail closed for safety-critical behavior.
- Skipped safety tests are not a green build.
- Review failure paths, not only happy paths.
- External side effects require special treatment.
- The model should match the task.
- Start manually, learn the workflow, then automate the handoffs.
- Rebase means replaying your branch commits on top of a newer base; it is not mainly a conflict-fixing command.
- After intentionally rewriting a published feature branch, prefer `git push --force-with-lease` over plain `--force`.
- Branches are Git history; worktrees are folders that let multiple branches stay checked out at the same time.
- Tooling that controls agents deserves the same review discipline as application code.
- A good agent system gets better by converting failures into durable rules.

---

## 23. Living Notes / Future Additions

Add new lessons here whenever Relay development teaches us something important.

Suggested format:

```text
Date:
Task:

What happened:

What surprised us:

Root cause:

New rule / lesson:

Where should the lesson live?
- notebook only
- AGENTS.md
- skill
- test
- repository docs
- GitHub issue template
```

This creates a lightweight engineering retro process.

---

## 24. Current North Star

The long-term goal is not to eliminate Taylor from the engineering process.

The goal is to move Taylor upward:

```text
Today:
Taylor writes prompts
Taylor transfers context
Taylor tells each worker what to do

Future:
Taylor chooses goals
Taylor approves architecture
Taylor reviews important decisions
Taylor controls risky actions
Taylor approves merges

Agents handle:
planning details
implementation
independent review
testing
handoffs
routine coordination
```

That is the shift from **using AI to code** to **operating an AI engineering team**.

---

## 25. Git Branch, Rebase, PR, and Worktree Lifecycle — October 18, 2026

This session completed a full professional Git lifecycle for both the prospect-intake feature and the Relay agent-infrastructure branch.

### Branch vs. worktree

The simplest mental model is:

```text
branch
= a named pointer / line of Git history

worktree
= a physical folder where one branch is checked out
```

A branch can exist without its own extra worktree. A worktree exists so another branch can be open in another folder at the same time.

For Relay:

```text
/Users/.../Relay
→ main

/Users/.../Relay-agent-tools
→ chore/agent-skills-setup
```

This was useful because product work and agent-tooling work could stay physically separated without constantly running `git switch` in one folder.

Useful commands:

```bash
git worktree list
git worktree remove <path>
git worktree prune
```

`git worktree remove` removes the extra checkout folder. It does **not** inherently merge the branch. `git worktree prune` only cleans stale worktree metadata; it is not the normal command for deleting an active worktree.

### What rebase actually means

Suppose a feature branch began from an older `main`:

```text
A ─── D                 main
 \
  B ─── C               feature branch
```

Rebasing the feature branch onto current `main` means:

> Take the commits made after the old branch point and replay them as if the work had started from the newest `main`.

After rebase:

```text
A ─── D                 main
      \
       B' ─── C'        feature branch
```

Conceptually, the branch's starting point moved forward. Technically, Git recreated `B` and `C` as new commits `B'` and `C'`, so their hashes changed.

Rebase is **not primarily about fixing conflicts**. Its main purpose here was to make the branch sit cleanly on today's `main`. If the new base and the branch changed the same area, rebase may expose a conflict while replaying the commits.

### Why a rebased remote branch needs special pushing

Before rebase, GitHub may still contain:

```text
remote branch:
A ─── B ─── C
```

while the local rebased branch now looks like:

```text
local branch:
A ─── D ─── B' ─── C'
```

A normal push cannot simply fast-forward the remote from `C` to `C'`, because the history was intentionally rewritten.

A plain force push says:

```text
--force
= overwrite the remote branch with my local history
```

The safer form says:

```text
--force-with-lease
= overwrite the remote only if it is still where I last observed it
```

The workflow used in Relay was:

```bash
git fetch origin
git push --force-with-lease
```

The fetch refreshes the local view of the remote. The lease then protects against overwriting unexpected remote work that appeared since that observation.

A useful rule:

```text
my short-lived feature branch before merge
→ rebase can be appropriate

shared branch other people depend on
→ do not rewrite history casually

main
→ do not rewrite published history
```

### Why VS Code Sync was intentionally avoided after rebase

For ordinary branch work, VS Code's **Sync Changes** button is convenient.

After an intentional rebase, however, local and remote history may show as diverged. At that point the desired action is very specific: replace the old remote feature-branch history with the reviewed rebased history, while protecting against unexpected remote changes.

That is clearer with:

```bash
git push --force-with-lease
```

rather than asking a general-purpose Sync action to decide how to reconcile the divergence.

Once the force-with-lease push succeeds and local/remote are aligned again, normal Sync is fine for ordinary future changes.

### Why squash merge can trigger "not fully merged" warnings

A normal feature branch might contain:

```text
A → B → C → D
```

A squash merge puts the combined result on `main` as one new commit:

```text
main: A → S
```

The code from `B/C/D` may be safely contained in `S`, but the original commits are not ancestors of `main`. Git can therefore warn that an old feature or backup branch is "not fully merged" even though the pull request was successfully squash-merged.

This taught an important distinction:

```text
Git ancestry says:
"Are these exact commits in main's history?"

Human/product question says:
"Did the final reviewed changes make it into main?"
```

After confirming the PR was merged and local `main` was updated, the obsolete local feature and backup branches could be deleted knowingly.

### Full lifecycle practiced

The workflow completed in this session was:

```text
create branch
    ↓
implement narrowly
    ↓
independent review
    ↓
remediate findings
    ↓
commit
    ↓
rebase onto current main when needed
    ↓
post-rebase review
    ↓
fetch remote state
    ↓
push --force-with-lease
    ↓
open PR
    ↓
squash merge
    ↓
GitHub deletes remote branch
    ↓
fetch --prune + pull main
    ↓
remove temporary personal tool links
    ↓
remove extra worktree
    ↓
delete obsolete local branch
    ↓
return to one clean main checkout
```

Post-merge checks used:

```bash
git fetch --prune
git pull --ff-only
git status
git worktree list
git branch
```

The desired final state was achieved:

```text
one worktree
one local branch: main
main = origin/main
working tree clean
```

### Agent-infrastructure result

The agent-infrastructure PR is now merged into `main`.

The durable project structure is:

```text
AGENTS.md
→ authoritative shared engineering handbook

.agents/skills/
├── relay-implement/
└── relay-review/
→ canonical Relay skills

CLAUDE.md
→ Claude-specific project entry point that imports/references shared rules

.claude/skills/
├── relay-implement -> ../../.agents/skills/relay-implement
└── relay-review    -> ../../.agents/skills/relay-review
→ project-local Claude compatibility without duplicate skill files
```

Temporary personal Claude symlinks under `~/.claude/skills` were removed after the project-local support reached `main`. The extra `Relay-agent-tools` worktree was then removed.

### Professional lessons from the lifecycle

- Keep product work and infrastructure work in separate branches and PRs.
- Review agent instructions like production engineering infrastructure; unsafe instructions can affect every future change.
- Re-review after a rebase when the base branch materially changed, because documentation or assumptions can become stale even when the branch itself rebases cleanly.
- Prefer explicit Git operations when history has intentionally been rewritten.
- Use `--force-with-lease`, not casual `--force`, for a rebased remote feature branch.
- A clean merge is not the end of the job; update local `main`, prune remote-tracking refs, remove temporary worktrees/links, and delete obsolete branches.
- The professional goal is not to memorize every command. It is to understand what Git object or workspace each command changes: branch history, remote-tracking state, worktree folder, or published remote branch.

