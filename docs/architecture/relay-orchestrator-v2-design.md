# Relay Orchestrator 2.0 — Architecture Design

Status: Draft

Priority: Reliability > Autonomy > Resource Efficiency

## 1. Problem Statement

The current Relay architecture requires manual coordination at several stages of the engineering workflow. As the system becomes more autonomous, it needs reliable mechanisms for recovering from failures and interruptions, selecting appropriate models, and avoiding unnecessary repetition.

The goal of Orchestrator 2.0 is to improve reliability while increasing autonomy and reducing Codex resource usage. These improvements must preserve existing safety requirements, independent review, and human approval for merging code.

## 2. Current Architecture

Relay uses a multi-agent engineering workflow that separates planning, implementation, review, and orchestration. Each agent has a defined responsibility, while the orchestrator coordinates execution and enforces engineering policies. This separation helps reduce the risk of agents validating their own assumptions and supports independent verification before changes are approved.

The planner investigates the GitHub issue and produces a structured handoff containing the technical approach, approved scope, risks, and required verification. The implementer receives the information necessary to complete its assigned work rather than the planner's entire working context.

Relay separates planning, implementation, and review into distinct agent responsibilities. The planner provides a structured technical handoff to the implementer, while the reviewer independently evaluates the implementation against the approved requirements, actual code changes, and verification evidence. The orchestrator coordinates these responsibilities and enforces the engineering policy.

The orchestrator coordinates the engineering workflow and enforces the established policy. It must verify execution evidence rather than relying solely on agent-reported outcomes. This includes confirming test results, approved scope, and the identity of the code being reviewed.

## 3. Proposed Architecture

Relay Orchestrator 2.0 will extend the existing multi-agent engineering workflow while preserving the separation between planning, implementation, and independent review.

The orchestrator will coordinate these agents using predefined engineering policies, structured communication, and persistent execution records. Engineering tasks will be executed sequentially according to their dependencies, with checkpoints allowing interrupted workflows to resume safely.

Model assignments will be selected automatically based on task complexity, risk, and recorded performance. Reliability will take priority over autonomy and resource efficiency.

The system will operate locally within the existing Codex environment. Final pull request merges will remain under human control.

### 3.1 Orchestrator

The orchestrator is responsible for selecting appropriate AI models and reasoning effort based on task complexity, risk, and historical performance.

It coordinates the engineering workflow by assigning tasks to the planner, implementer, and independent reviewer. Once implementation is complete, the orchestrator verifies the commit and required test evidence before initiating independent review.

After the review is complete, the orchestrator evaluates the findings against predefined engineering policies to determine whether the workflow can proceed, requires additional investigation, or must stop.

The orchestrator must operate within established authorization boundaries. It cannot independently modify application code, merge pull requests, change authoritative GitHub requirements, perform the independent code review, or weaken engineering safety policies. These responsibilities remain with their designated agents or require explicit human authorization.

### 3.2 Planner

The planner is responsible for investigating GitHub issues and determining the technical scope, complexity, risk, dependencies, and verification requirements.

It produces a structured implementation plan containing the context necessary for the implementer to complete the task.

When an issue is too complex for reliable implementation, the planner should recommend decomposition into smaller, independently verifiable tasks. The orchestrator validates the recommendation against engineering policies and obtains human approval when new GitHub sub-issues must be created.

Each task can receive its own focused implementation plan while remaining linked to the original approved requirements.

If the planner discovers missing requirements, technical limitations, or an infeasible implementation, it must return a blocked status with supporting evidence and recommended alternatives.

The planner cannot independently change the original GitHub issue description or authorize new product requirements. Proposed requirements changes must be documented as amendments and approved by the human owner before implementation proceeds.

### 3.3 Implementer

The implementer is responsible for executing the approved technical plan provided by the planner. It receives a structured handoff containing the required changes, authorized file scope, relevant context, and verification requirements.

The implementer may read relevant repository files but must restrict modifications to the files authorized by the orchestrator. It cannot independently expand the approved scope, change engineering policies, or modify authoritative GitHub requirements.

If additional changes are necessary, the implementer must stop and report the discovery to the orchestrator for planner-led reassessment. Implementation may resume automatically when the revised technical scope satisfies established policies. Any changes to the original requirements or explicit issue restrictions require human approval.

After completing its assigned task, the implementer runs the required implementation checks and creates a local Git commit containing the authorized changes. The implementer then provides the commit SHA and verification results to the orchestrator.

The orchestrator independently validates the commit, authorized file scope, repository state, and verification evidence before permitting publication.

Once these checks pass, the orchestrator may automatically authorize pushing the commit to the designated GitHub issue branch under a predefined, narrowly scoped publication policy. Each push must be verified against the intended repository, branch, and commit, without overwriting unexpected remote changes.

This automatic push serves as a remote recovery checkpoint. It does not constitute approval of the implementation or authorization to merge.

The implementation must undergo independent review against the exact commit. Any identified defects or unresolved concerns are returned to the orchestrator for policy-governed recovery or escalation.

### 3.4 Reviewer

The reviewer is responsible for independently evaluating completed implementation work against the approved GitHub issue requirements, including any authorized amendments.

The reviewer receives the exact commit SHA, relevant verification requirements, and access to the repository in a fresh context. It must independently examine the code changes and their effects on related components rather than relying on the implementer's explanation.

The reviewer may inspect the relevant codebase, analyze dependencies, and execute authorized tests or targeted investigations. It must not modify application code, expand implementation scope, change authoritative requirements, or approve merging code into `main`.

Review findings must be structured and supported by technical evidence. Findings should distinguish between confirmed implementation defects, requirements ambiguity, unverified technical concerns, and requirements defects.

Passing automated tests does not automatically establish review approval. When a potentially significant concern remains unresolved, the reviewer must return `BLOCKED` with supporting evidence and recommended investigation steps.

The orchestrator evaluates the review findings against predefined engineering policies and determines the appropriate recovery process. Confirmed implementation defects may trigger a stronger qualified implementer, while unclear or defective requirements are returned for planner-led reassessment and the applicable human authorization.

Each internal implementation task requires independent review. The completed feature must also undergo final integration review against the full approved requirements before the pull request is presented for human merging.

### 3.5 Agent Communication Contracts

#### Shared Communication and Validation

Relay Orchestrator 2.0 will use structured communication contracts between the orchestrator, planner, implementer, and reviewer.

Each agent returns a defined response. Zod validates the response structure, deterministic orchestrator policies determine whether proposed actions are authorized, and independent evidence verification determines whether reported outcomes are supported.

Agents cannot directly authorize one another's actions. The orchestrator controls workflow transitions, permissions, and recovery.

Agent responses and verification evidence must carry the orchestrator-controlled run ID, task ID, attempt ID, authorized requirements version, schema version, exact commit SHA where applicable, and evidence references. The orchestrator validates these against trusted execution state; stale, mismatched, or unverifiable evidence cannot advance a task.

#### Planner Communication Contract

The initial planner response reports `READY` or `BLOCKED`.

A `READY` response includes the proposed implementation plan, internal task queue when appropriate, dependencies, file scope, risk, complexity, and verification requirements.

A `BLOCKED` response includes the reason, supporting evidence, and recommended next action.

The orchestrator validates the proposed plan before implementation.

#### Implementer Communication Contract

The implementer reports `COMPLETED` or `BLOCKED`.

A `COMPLETED` response includes the task identifier, commit SHA, changed-file list, and verification evidence.

A `BLOCKED` response includes the reason and supporting evidence.

The orchestrator independently verifies the actual Git changes, authorized scope, and required check results. Agent-reported completion is not independent proof.

#### Validation Feedback and Recovery

When a planner response violates schema or engineering policy, the orchestrator returns specific validation feedback for a bounded correction attempt.

Repeated equivalent failures may trigger escalation to a stronger qualified planning model when additional reasoning could resolve the problem.

External blockers and unresolved failures must not produce unlimited retries.

Before task advancement, the orchestrator checks evidence against the currently authorized GitHub requirements version. An approved amendment pauses progression for impact assessment; unaffected evidence may be reused only after its continued validity is established. Recovery ordering accounts for safety, severity, and dependencies while preserving unaffected completed work.

#### Reviewer Communication Contract

The reviewer will return one of two statuses: `PASSED` or `BLOCKED`.

A `PASSED` response must identify the exact commit reviewed and provide evidence that the required review coverage has been satisfied. This includes the relevant files examined, requirements and behaviors evaluated, verification checks performed, and supporting results.

A `BLOCKED` response must include structured reasons, technical findings, supporting evidence, and recommended next actions. Incomplete verification will be represented as a blocking reason rather than a separate top-level status.

The reviewer must distinguish between confirmed implementation defects, requirements ambiguity, unverified technical concerns, and requirements defects. The absence of reported defects does not establish successful review when mandatory coverage or verification remains incomplete.

A `BLOCKED` response may contain multiple findings. Each finding carries a stable identifier, classification, severity, supporting technical evidence, and recommended action. The orchestrator tracks and verifies resolution of each finding. Reviewer-level `BLOCKED` does not automatically terminate the engineering run.

The reviewer may recommend additional tests or investigations. Significant unresolved technical or safety concerns are blocking findings; noncritical recommendations may remain nonblocking under deterministic orchestrator policy. The orchestrator selects authorized recovery actions and cannot disregard mandatory blocking findings.

#### Review Coverage and Independence

The reviewer may investigate relevant files, dependencies, and system behaviors beyond the implementer's authorized modification scope. This investigative access does not grant permission to modify those files or authorize additional implementation work.

Where technically supported, the reviewer's execution environment must enforce read-only access to application code.

The reviewer may run additional existing tests when authorized and safe for the environment. Tests may generate temporary artifacts in designated isolated locations, and database operations require existing authorization and safety preflight checks. The reviewer cannot modify application source code or create new repository test implementations. The orchestrator verifies that protected files and the reviewed commit remain unchanged.

The orchestrator must independently compare the reviewer's reported coverage against the approved requirements, actual Git changes, and required verification. Missing evidence, unexamined required areas, or unresolved significant concerns must prevent the task from advancing.

When review uncovers previously unidentified dependencies or risks, the orchestrator determines whether additional verification, planner-led scope reassessment, or human authorization is required. The reviewer cannot independently expand implementation scope.

## 4. Functional Requirements

These requirements define observable orchestration behavior. They describe the proposed system, not functionality already implemented. Each requirement should be validated with deterministic tests and, where appropriate, controlled integration scenarios. Recovery must continue to honor the authorization and independent-review policies defined in Section 3 and Appendix A.

### 4.1 Checkpoint and Repository Recovery

#### FR-001 — Safe Checkpoint Reconciliation

When an interrupted engineering run resumes, the orchestrator must reconcile its persisted checkpoint with the actual local repository, authorized GitHub repository and branch, commit history, approved requirements version, and recorded verification evidence before authorizing further work.

It must identify missing, stale, or conflicting state; preserve unexpected changes; and must not automatically reset a branch or overwrite unexpected remote commits.

**Verification scenario:** A checkpoint references verified commit `abc123`, but the issue branch points to `def456`. The orchestrator detects the mismatch and does not dispatch additional work or overwrite the branch before reconciliation.

#### FR-002 — Unexpected Commit Impact Assessment

When repository state differs from the saved checkpoint, the orchestrator must determine whether the unexpected changes affect approved requirements, completed tasks, task dependencies, or the validity of existing tests and reviews. It may request planner-led investigation when necessary.

Demonstrably unaffected work may be preserved under approved recovery policy. Affected work must be revalidated; uncertain or unauthorized changes must not be silently accepted, discarded, or overwritten. Change size or filename alone is not sufficient proof that a change is safe.

**Verification scenario:** An unexpected commit modifies code used by a verified task. The orchestrator records the impact and prevents reuse of affected approval evidence until revalidation.

### 4.2 Verification and Test Environment Recovery

#### FR-003 — Selective Test Recovery

After an interruption, the orchestrator must distinguish checks that passed, failed, or did not complete. A passing result may be reused only when its commit identity, applicable requirements version, test configuration, execution environment, and relevant dependencies remain valid.

Incomplete or invalidated checks must be rerun. Confirmed failures require diagnosis rather than being treated as interruptions. Broader suites must still run when engineering policy requires them, including applicable final integration and CI verification.

**Verification scenario:** Two independently isolated checks have trustworthy passing evidence and a third was interrupted. With unchanged inputs and environment, Relay reruns the third check without unnecessarily repeating the first two.

#### FR-004 — Safe Test Environment Recovery

If an interruption may have changed shared test state, the orchestrator must establish the target environment's identity, isolation guarantees, and permitted recovery operations before using existing results or rerunning tests.

Where shared state may be contaminated, recovery must use an authorized, known-clean state and rerun affected checks. Destructive reset or database operations require the applicable safety authorization and preflight checks. If environmental identity or authorization cannot be established, database recovery and affected verification must remain blocked.

**Verification scenario:** A test modifies a shared database before a crash. Relay does not rerun tests or reset the database until it verifies that the target is the authorized disposable test environment.

### 4.3 Task Dispatch and Review Recovery

#### FR-005 — Dependency-Gated Task Dispatch

The orchestrator must not dispatch an implementation assignment until all of its required dependencies have been independently verified and the task's scope, requirements, and environment authorizations are valid. These conditions must be checked again immediately before dispatch.

Task handoffs may be prepared and saved in advance, but preparing a handoff does not authorize the implementer to act.

**Verification scenario:** Task B depends on Task A. While A lacks verified approval, Relay may store B's proposed handoff but must not launch B's implementer.

#### FR-006 — Interrupted Review Recovery

A review counts as completed only after a full structured reviewer result has been received, validated, bound to the applicable execution and commit identities, and durably recorded.

If a reviewer is interrupted without such a result, the orchestrator must retain verified implementation and publication evidence, record the interrupted attempt, and—after rechecking the commit, requirements, and applicable evidence—launch a fresh independent review of that commit. Partial review artifacts cannot authorize advancement.

**Verification scenario:** Codex closes during review after a verified commit was safely pushed. On restart, Relay records the interrupted review, preserves implementation work, and starts another review rather than rerunning implementation or treating the partial review as passed.

### 4.4 Git Publication and Evidence History

#### FR-007 — Idempotent Git Publication Recovery

Before retrying an interrupted push, the orchestrator must query the designated remote repository and branch to verify whether the expected commit is already present at the required branch state.

If publication is already confirmed, Relay must record the outcome without blindly pushing again. If the remote branch head differs, Relay must inspect ancestry, relevant changes, authorization, and verification evidence before reconciling. It must not force-push, reset, or overwrite unexpected remote history.

**Verification scenario:** A push succeeds but Relay crashes before checkpointing. On restart, the orchestrator recognizes the expected remote commit and records publication as complete without creating another commit or changing the branch.

#### FR-008 — Historical Evidence Preservation and Commit-Specific Review

When an implementation changes after review, the orchestrator must preserve previous review attempts, outcomes, and supporting evidence as historical records while distinguishing them from current approval evidence.

Approval for an older commit must not automatically transfer to a newer commit. The orchestrator must reassess affected verification and obtain independent review applicable to the current commit before marking the task verified. Historical outcomes may contribute to model-performance analysis but do not by themselves constitute controlled benchmark results or current approval.

**Verification scenario:** Commit `abc123` passed review; a subsequent `def456` changes implementation code. Relay retains the earlier review for history, but does not mark `def456` verified without applicable new review.

### 4.5 Idempotent External Operations

#### FR-009 — Idempotent External Actions

Before any authorized external side effect that could be duplicated on retry—for example, creating a GitHub issue, pull request, or comment—the orchestrator must durably record a stable operation identifier, intended target, authorization, and pending action.

Where the external service permits it, Relay should include a recognizable operation marker in the created resource. Recovery must inspect external state and verify a matching result before retrying. Ambiguous outcomes must not cause blind repetition; if safe reconciliation is not possible, the action remains blocked for human input.

**Verification scenario:** Relay creates an authorized GitHub sub-issue but crashes before recording its number. Recovery searches for the operation marker and does not create an apparent duplicate.

#### FR-010 — External Action Outcome Reconciliation

When an external operation completed but its success was not durably recorded, the orchestrator must independently verify the matching external resource, its target repository or branch where relevant, and the original authorization, then update the checkpoint to reflect the completed action without replaying it.

If the outcome cannot be established unambiguously, the orchestrator must preserve the uncertain operation state and prevent unsafe retries.

**Verification scenario:** The local record says `IN_PROGRESS`, but GitHub shows exactly one correctly authorized issue carrying the matching operation marker. Relay records the returned issue identity and marks the action completed without creating another issue.

## 5. Reliability and Safety Requirements

## 6. Model Routing and Cost Optimization

## 7. Execution State and Recovery

## 8. Implementation Phases

## 9. Open Questions

## Appendix A — Architecture Decision Register

**Status:** Agreed design direction, not yet implemented

**Priorities:** Reliability → Autonomy → Resource Efficiency

This register records the architectural decisions made during the Orchestrator 2.0 design process. It should be updated whenever a decision changes.

### A1. Agent Responsibilities

- **Orchestrator:** Coordinates agents, selects qualified models, manages the task queue, verifies evidence, enforces policy, and handles recovery.
- **Planner:** Investigates requirements, determines complexity and risk, defines technical scope, identifies coverage gaps, and recommends implementation tasks.
- **Implementer:** Makes authorized code changes using a focused planner handoff.
- **Reviewer:** Independently examines requirements, code changes, and verification evidence using fresh context.
- **Human owner:** Approves authoritative requirements amendments, policy changes, and final PR merges.

The orchestrator must not independently implement code, conduct the independent review, change authoritative requirements, or weaken safety policies.

### A2. GitHub Issues and Task Decomposition

- Keep **one parent GitHub issue per cohesive feature** by default.
- The original issue description serves as the preserved requirements baseline.
- Requirements amendments are proposed through GitHub comments.
- Only explicitly authorized amendments become part of the effective requirements.
- The planner recommends breaking complex work into smaller, independently verifiable tasks.
- The orchestrator validates the proposed breakdown against scope and dependency rules.
- **Internal tasks are preferred over creating multiple GitHub issues.**
- New GitHub sub-issues are reserved for independently deliverable work and require human approval to publish.
- Each internal task receives its own focused implementation plan.
- **REL-039 — Single-pass task decomposition:** The initial planner handoff proposes the internal task queue, dependencies, file scope, and verification requirements together when decomposition is appropriate. Focused task replanning should reuse prior investigation rather than repeat the entire planning process.

### A3. Task Scheduling

- Use a dependency-aware internal task queue.
- Execute **one implementation task at a time**.
- A task cannot begin until its required dependencies are verified.
- Generally prioritize lower-complexity, lower-risk eligible tasks unless technical evidence supports a different order.
- When one task is blocked, unrelated tasks may continue if the blocker does not affect overall safety.
- Complete a final integration review before presenting the whole issue for merge.
- Preserve completed work when replanning; revisit only affected tasks and verification evidence.
- **REL-048 — Selective Task Invalidation:** When authorized requirements change, the orchestrator evaluates the effect on the internal task queue and dependency graph. Completed tasks and evidence remain preserved when valid; only affected tasks, plans, dependencies, and verification evidence are invalidated or re-executed. Downstream tasks depending on changed work are reassessed.
- **REL-050 — Dependency-Aware Recovery Ordering:** The orchestrator evaluates severity, safety implications, and dependencies when ordering recovery. Critical safety concerns immediately prevent unsafe progression or publication. Within those boundaries, recovery follows technical and requirements dependencies rather than severity alone. Unresolved findings remain tracked until independently resolved or dispositioned under approved policy.

### A4. Model Selection and Resource Usage

- The orchestrator automatically selects models from an approved, qualified pool.
- Complexity influences the implementer's model and reasoning effort.
- Risk determines mandatory safeguards and review rigor.
- Historical performance records improve future model selection.
- Resource efficiency is measured across the entire successful engineering workflow, including rework.
- There is no fixed resource budget per ticket, but repeated unsuccessful attempts must be bounded.
- Confirmed implementation defects trigger the authorized stronger-model correction process.
- New or unproven models require controlled qualification before autonomous production use.
- Agents cannot override mandatory safety policy to save resources.
- **REL-038 — Bounded planning-model escalation:** The orchestrator returns specific feedback on an invalid or insufficient plan. If an equivalent error persists after a bounded correction attempt, it may assign a stronger qualified planning model under the approved routing policy. Unresolved failures or missing capabilities remain blocked.

### A5. Reliability and Safety

- Use deterministic policy enforcement for authorization, file scope, environment checks, and workflow transitions.
- Zod schemas validate structured agent outputs but do not replace independent evidence verification.
- Implementers receive the minimum necessary write permissions.
- Unauthorized file modifications must be prevented where technically enforceable and detected before workflow advancement.
- Database operations require authorization separate from source-code modifications.
- Requirements defects and unresolved critical safety concerns block affected work.
- Technical replanning may resume automatically within approved scope and bounded limits.
- Passing tests and an agent's statement of success do not establish authorization to proceed.
- **REL-040 — Scope violation recovery:** Unauthorized modifications block advancement and publication. The orchestrator records the attempted commit, actual unauthorized changes, and supporting evidence. Accidental changes may be corrected under approved recovery rules; technically necessary changes return to the planner for scope reassessment. Every corrected implementation requires renewed applicable verification.

### A6. Independent Review and Verification

- Every implementation requires independent review.
- Review findings must include supporting technical evidence.
- Findings distinguish implementation defects, requirements ambiguity, unverified technical concerns, and requirements defects.
- The orchestrator verifies the actual commit, scope, and required test results.
- Previous evidence may be reused only when it remains valid for the relevant changes.
- The final version must satisfy all mandatory verification and approval requirements.
- Unresolved reviewer concerns remain blocked; additional investigation requires the applicable authorization.
- **REL-041 — Evidence-based review coverage:** The reviewer must identify the exact commit examined, relevant files and behaviors investigated, requirements checked, completed verification, supporting evidence, and coverage limitations. The orchestrator independently evaluates whether mandatory review coverage is satisfied.
- **REL-042 — Independent investigation without implementation authority:** Reviewers may inspect relevant dependencies outside the authorized implementation file scope but cannot modify code or authorize additional implementation work. Newly discovered risks follow orchestrator-controlled investigation and replanning procedures.
- **REL-043 — Minimal review status model:** Reviewer responses use `PASSED` or `BLOCKED`. A blocked response must include structured reasons and supporting evidence. Incomplete verification is a blocking reason, not a separate top-level status.
- **REL-044 — Controlled Reviewer Test Execution:** The reviewer may independently run additional existing tests when authorized and safe for the environment, but cannot modify application source, create new repository test implementations, or change authoritative requirements. Test artifacts are limited to designated isolated locations; database operations require existing authorization and safety preflight checks. The orchestrator verifies protected files and the reviewed commit remain unchanged.
- **REL-045 — Reviewer Recommendations and Blocking Findings:** The reviewer may recommend tests or investigations but cannot authorize implementation changes. Significant unresolved technical or safety concerns block review; noncritical recommendations may be nonblocking under deterministic orchestrator policy. The orchestrator determines recovery and cannot disregard mandatory blocking findings.
- **REL-049 — Independent Review Findings:** A reviewer may include multiple findings in one `BLOCKED` response. Each finding has a stable identifier, classification, severity, technical evidence, and recommended action. The orchestrator tracks each finding, preserves context, evaluates relationships, and verifies resolution before review succeeds. The top-level statuses remain `PASSED` and `BLOCKED`; reviewer-level `BLOCKED` need not terminate the run.

### A7. Execution Records and Recovery

- Store durable execution checkpoints locally using structured JSON records.
- Maintain separate execution records for each active engineering run.
- Record task states, dependencies, commit SHAs, model assignments, review findings, verification evidence, and approvals.
- Preserve the authorized requirements version and references to GitHub approval evidence.
- On restart, validate checkpoints against the current Git and GitHub state.
- Resume from the earliest incomplete or invalid stage rather than repeating all completed work.
- When awaiting human input, save the state and stop the active workflow.
- After confirming that the associated pull request has merged, archive the execution record.
- Retain detailed records for recent completed runs. When the configured retention threshold is reached, preserve compact historical summaries containing model performance, task characteristics, and verification outcomes.
- Never automatically remove active, blocked, or awaiting-approval execution records.
- A local Codex session does not need to remain running while work is paused.
- **REL-046 — Execution-Bound Agent Responses:** Agent responses and verification evidence are associated with orchestrator-controlled run ID, task ID, attempt ID, authorized requirements version, schema version, exact commit SHA where applicable, and evidence references. The orchestrator validates them against trusted execution state. Stale, mismatched, or unverifiable evidence cannot authorize advancement.
- **REL-047 — Requirements-Version Consistency:** Before advancing a task, the orchestrator verifies evidence against the currently authorized GitHub requirements version. An approved amendment pauses progression for impact assessment. Prior verification is reused only when still valid; affected work receives appropriate replanning, implementation, or review.

### A8. Execution Environment and Merge Authority

- Orchestrator 2.0 is **local-first**, running through the existing Codex environment.
- Cloud workers, autonomous GitHub Actions execution, and unattended remote agents are deferred.
- Pull requests may be prepared or published under the applicable authorization policy.
- The orchestrator may automatically push verified commits to a designated issue branch under a narrowly scoped publication policy. This does not authorize merging into main.
- **Only the human owner may approve the final merge into `main`.**

### A9. Decisions Still Requiring Technical Validation

- The precise implementation of deterministic policy gates and file-level permissions.
- The storage format and crash-safety guarantees of local checkpoints.
- The exact GitHub requirements-amendment approval mechanism.
- Thresholds for automatic replanning and model qualification.
- Runtime support for model routing, reasoning-effort settings, and independent agent contexts.
- The implementation phases and necessary changes to existing Relay skills and policies.

These details should be validated against the existing Relay repository before implementation begins.
