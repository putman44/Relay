# Local Planner attempt reservation

`FileAttemptReservation` implements `TrustedAttemptReservation` for a trusted caller-supplied, pre-existing absolute directory. It does not install a host adapter or authorize dispatch. The caller must retain the directory for the life of all attempts and must not place it in a synchronized, shared, or ephemeral location.

The filename is a SHA-256 digest of a JSON array in fixed field order: canonical host, canonical repository, issue number, run ID, task ID, attempt ID. `requirementsVersion` is excluded. The record contains only these identity fields, schema version, and digest; it contains no approved issue body, credentials, provider payload, or approval evidence. Hashed filenames are opaque, but the record's identity is readable to the owning user.

The provider requires a private directory owned by the current user, rejects symlinks and unsafe ancestors, and accepts only recognized local APFS, ext4, XFS, or Btrfs filesystem types. It does not create the directory. Exclusive creation (`O_EXCL`) selects one claimant across local processes. The winner writes the record, syncs the file, closes it, syncs the parent directory, and checks the directory again before returning `RESERVED`. A second claimant reads the existing file without following symlinks. Only an exact, regular, private, single-link record yields `ALREADY_RESERVED`; a partial, corrupt, mismatched, or unreadable record throws. Neither result authorizes another dispatch. All uncertain writes, syncs, and closes throw, and the record is retained for manual reconciliation.

This design assumes the caller controls the directory and that no same-user adversary changes ancestors or files concurrently. Node path-based operations cannot pin every ancestor against malicious same-user replacement. Filesystem type detection is conservative and does not prove mount options, storage hardware, or remote backing. Local process concurrency and process restart are covered by exclusive creation and retained files. A crash before creation leaves no claim; a crash after creation leaves either an incomplete hold or a duplicate claim. Tests exercise local-process behavior and injected ambiguous I/O. File and directory synchronization provide the available OS durability barrier, but physical power-loss durability remains unproven. A human must reconcile ambiguous records; there is no release, expiry, deletion, overwrite, or automatic retry path.

The existing Planner handoff still requires exact model, reasoning-effort, and fresh-context proof. Current host compatibility remains unproven, so this provider is not a live-dispatch readiness decision.

## Host compatibility assessment (2026-11-08)

The repository policy at `.agents/relay-orchestration-policy.json` requires:

| Role | Exact model | Exact reasoning effort | Observed compatibility |
| --- | --- | --- | --- |
| Planner | `gpt-6.1-sol` | `medium` | Model and effort are advertised; exact dispatch and fresh independent context are unproven. |
| Implementer | `gpt-6.1-sol` | `high` | Model and effort are advertised; exact dispatch and fresh independent context are unproven. |
| Reviewer | `gpt-6.1-sol` | `high` | Model and effort are advertised; exact dispatch and fresh independent context are unproven. |

In this session, the Codex host-exposed subagent interface advertises `gpt-6.1-sol` as a model override, `medium` and `high` reasoning-effort controls, and `fork_turns: "none"` for a fresh context. The owner explicitly approved these provisional role settings for policy alignment only. The interface did not expose a runtime version or provide proof of exact model-and-effort execution, fresh independent context, or response and identity semantics. No agent was dispatched as a probe. Advertisement is not capability proof; each role's exact combination remains **UNPROVEN**.

No verified production `PlannerHost` adapter is installed. The current conclusion is `HOST_DISPATCH_UNAVAILABLE`; if an adapter is later supplied without exact per-role capability proof, the handoff must return `CAPABILITY_UNPROVEN`. Live Planner dispatch remains blocked pending separate evidence and authorization.

The reservation identity excludes policy settings and the record does not retain a policy digest. An in-flight attempt spanning a policy change therefore has no durable proof of which role settings governed its earlier capability check or dispatch. Existing duplicate-attempt holds prevent reusing the same attempt identity, but do not resolve that evidence gap for an unresolved attempt. Before any real dispatch, a separate integration gate must bind the approved policy identity to each attempt and define a fail-closed STOP and reconciliation path for policy changes during an unresolved attempt. This policy update does not resolve that risk or authorize a retry.
