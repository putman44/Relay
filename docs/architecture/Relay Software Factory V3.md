# Relay Software Factory V3

## Lean Execution Plan

**Status:** Draft  
**Version:** 3.0  
**Date:** November 9, 2026  
**Guiding principle:** Make the simplest working system before adding complexity.

---

## 1. Purpose

Relay V3 will connect our existing Planner, Implementer, and Reviewer into a functioning AI software engineering team.

The user provides a GitHub issue. Relay coordinates the engineering process, validates the results, and prepares a pull request for human approval.

V3 is an implementation plan, not a replacement for the Relay Orchestrator 2.0 architecture.

**Priority: Reliability → Working Automation → Efficiency**

## 2. What We Have Already Built

The following components exist:

- `AGENTS.md` — repository-wide engineering and safety rules.
- `relay-plan` — planning instructions.
- `relay-implement` — implementation instructions.
- `relay-review` — independent review instructions.
- `relay-orchestrate` — workflow coordination instructions.
- Zod contracts — structured agent response validation.
- Orchestration foundations — state transitions, policies, checkpoints, reservations, and recovery components.
- Experimental API Planner — successfully tested using the OpenAI Responses API.

**Proven milestone:** GitHub Issue #19 was implemented, independently reviewed, verified, and merged through PR #36.

**Current limitation:** Agent handoffs were coordinated manually. A complete automated execution workflow has not been demonstrated.

## 3. Target V3 Workflow

```text
GitHub Issue
     |
     v
Relay Orchestrator
     |
     v
Planner
     |
     | Validated plan
     v
Implementer
     |
     | Code changes + tests
     v
Verification
     |
     | Fixed commit
     v
Independent Reviewer
     |
     | Approved review
     v
GitHub Pull Request
     |
     v
Human Merge Approval
```

Relay should manage the repetitive coordination between agents.

Humans retain control of requirements changes, consequential permissions, and final merges.

## 4. V3 Architecture

### Orchestrator

A small TypeScript execution controller that:

- Accepts one explicitly selected GitHub issue.
- Invokes the appropriate agents.
- Validates their outputs.
- Checks trusted evidence and authorization.
- Passes approved context between agents.
- Stops when intervention is required.

### Planner

- Reads the authoritative issue and relevant repository context.
- Produces a structured, actionable plan.
- Identifies missing requirements and risks.
- Cannot modify code or authorize implementation.

### Implementer

- Receives the issue, plan, and authorized scope.
- Inspects the repository.
- Implements the requested changes.
- Runs permitted verification.
- Reports results without approving its own work.

### Reviewer

- Runs in a fresh, independent context.
- Reviews the exact committed code against the issue.
- Evaluates specification, safety, and engineering standards.
- Returns structured findings and a recommendation.
- Never modifies the reviewed code.

### Execution runtime

V3 must use a supported runtime capable of invoking real agents.

Before integration, verify what the selected runtime can actually guarantee about model selection, permissions, tool access, and independent contexts.

Do not invent execution evidence or bypass existing safety checks to make dispatch succeed.

## 5. Implementation Milestones

### V3-001 — Validate the Execution Runtime

**Goal:** Establish one supported way to invoke agents programmatically.

Work:

- Inspect the current Codex and API execution options.
- Reuse our existing Planner experiments as evidence.
- Identify which capabilities can be verified.
- Select the simplest viable execution approach.

**Done when:** A real, controlled agent invocation is demonstrated, its limitations are documented, and the next integration step is technically supported.

If the current architecture's execution requirements cannot be satisfied, stop for an explicit design decision rather than weakening them silently.

### V3-002 — Automatic Planner Handoff

**Goal:** Relay invokes the Planner and prepares a validated implementation handoff.

Work:

- Receive an explicitly selected GitHub issue.
- Invoke the real Planner.
- Validate its structured output.
- Preserve issue authority and execution identity.
- Produce a handoff without manual copying.

**Done when:** One real issue successfully produces a validated handoff, and a deliberately invalid or blocked case stops correctly.

### V3-003 — Automatic Implementation Handoff

**Goal:** Relay invokes an independent Implementer using the accepted plan.

Work:

- Pass the authoritative issue, approved scope, and plan.
- Execute in an authorized development environment.
- Collect changed-file and verification evidence.
- Stop on scope violations or unresolved decisions.

**Done when:** A real Implementer can receive a handoff and complete an authorized change without manual prompting.

### V3-004 — Independent Review and Pull Request

**Goal:** Complete the engineering cycle.

Work:

- Verify the implementation and create a fixed commit.
- Launch an independent Reviewer.
- Validate review findings against the exact commit.
- Prepare a GitHub PR only when the required gates pass.
- Stop for human merge approval.

**Done when:** One real GitHub issue progresses from Planner to a verified PR without manual agent-to-agent handoffs.

## 6. Safety Rules We Keep

V3 will preserve:

- GitHub Issues as authoritative requirements.
- Existing `AGENTS.md` rules and database protections.
- Explicit authorization for consequential actions.
- File-scope checks and trustworthy Git evidence.
- Independent review against exact commits.
- No automatic merging into `main`.
- No automatic retries when an external outcome is uncertain.
- No agent-generated authorization.

These protections are part of the working engineering process, not optional enhancements.

## 7. What We Will Not Build Yet

The first V3 implementation will not require:

- Automatic model optimization based on task complexity.
- Parallel implementation teams.
- Autonomous GitHub issue discovery.
- Complex scheduling or task prioritization.
- New worktrees for every task.
- Additional layers of agent management.
- Sophisticated automatic recovery beyond existing safe boundaries.
- Replacing existing components without demonstrated need.

These remain possible future improvements, not prerequisites for the first working factory.

## 8. Development Rules

- Work on one GitHub issue at a time.
- Prefer one primary development workspace and ordinary feature branches.
- Reuse existing Relay skills and infrastructure where appropriate.
- Make the smallest change that demonstrates a real capability.
- Test actual execution rather than relying only on simulations.
- Include successful and correctly blocked scenarios.
- Require independent code review before merging.
- Avoid architectural expansion unless a demonstrated problem requires it.

## 9. Definition of V3 Success

V3 is successful when:

1. A user selects one GitHub issue.
2. Relay invokes a real Planner.
3. Relay passes the validated plan to a real Implementer.
4. The Implementer produces verified code changes.
5. Relay invokes an independent Reviewer.
6. Required verification and review gates pass.
7. Relay prepares a GitHub pull request.
8. The user makes the final merge decision.

**No manual copying of prompts or agent results between these steps.**

## 10. What Comes After V3

Once the basic factory works reliably, we can consider adaptive model selection, more advanced task scheduling, automated recovery, cost optimization, and additional specialist agents.

Those features should be justified by results from real V3 executions rather than implemented in advance.

---

## Final Principle

**Build a working software factory first. Make it smarter second.**

V3 succeeds when Relay can reliably coordinate a real engineering task—not when it has the most elaborate orchestration architecture.
