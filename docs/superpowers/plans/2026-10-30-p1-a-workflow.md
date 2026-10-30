# P1-A isolated work workflow implementation plan

> For agentic workers: implement with subagent-driven-development; user authorization and bounded verification override automatic commits, cleanup and redundant reviews.

**Goal:** A usable offline single-worker coding workflow accepting a user goal and a fresh taskboard-cli repository, with scoped tools, loopback HTTP mock provider, durable evidence, cancellation and patch delivery.

**Architecture:** Keep OpenCode primary and Pi comparison through the existing official SDK adapter. Add a thin P1 host entry rather than another agent loop. Reuse secure text/snapshot primitives, request intent ledger, protocol adapter and mature diff backend where their contracts fit. Taskboard data and mock response scripts remain fixtures; no task-specific answers in product code.

**Tech Stack:** Existing Node 22/Bun 1.4.4/ESM/node:test and lockfile. No dependency upgrades or external providers.

**Spec:** docs/p1-a-spec-2026-10-30.md (eight modules and acceptance, plus final authorization clarification).

## Global Constraints

- Worktree: current feature branch feat/p1-a-workflow, base ee57d711760b0abf001007a2a479759ea26a15c1. One implementation writer. Other project repositories and original private research remain untouched.
- Zero real model requests; no credentials, service recovery, model download, deployment, UI, training, paid fallback, Git commits or remote operations.
- Official SDK loops must actually run. Mock provider is an ephemeral exact loopback HTTP endpoint with explicit per-run identity; arbitrary remote hosts/config/redirects must fail closed.
- One worker/concurrency one, bounded requests/output/deadline/tools/commands. Persistent intent before every model/tool side effect. UNKNOWN or incomplete state prevents redispatch. Reopen must be entirely read-only.
- Scope, approved command IDs and final acceptance come from host config, never model output. Keep repo instructions as context, not authority to extend permissions.
- Snapshot source preservation, expected-hash edits, exact new-file allowlist, protected acceptance, final artifact membership/hash verification and standard patch output including new files.
- Distinguish user wait, stream, SDK, tool process and remote inference states. No auto-resume or blind retry.
- Reuse same-version evidence. Targeted checks during implementation; one full integration at final state unless a failure or subsequent change justifies another.

## Review Focus

- A caller-supplied repo, goal or context must not select a canned answer or escape paths/commands/config.
- Model tool output can claim success, but only final host checks over the delivered snapshot can accept it.
- New-file creation, stale edit, symlink/hardlink, protected file change and artifact omission must fail closed.
- HTTP body/stream errors, partial arguments, cancellation and unknown tool acknowledgements must not lead to retry or dispatch after stop.
- Reopen/export must verify saved evidence and not create SDK sessions, execute tests or touch source.

## Task 1: Complete the P1-A vertical slice (all eight modules)

**Files:** Create focused src/p1-*.mjs modules and test/p1-*.test.mjs, fixtures/taskboard-cli plus host contracts/mock response fixtures; modify existing SDK/tool primitives only when required and preserve default legacy behavior. Add CLI scripts to package.json and matching lockfile metadata; document the actual final CLI in docs/p1-a-usage.md and README/CHANGELOG.

**Interfaces:** Provide one CLI run command accepting absolute repo/config/state-root plus a goal or goal file, harness selection and mock profile; readonly reopen and artifact export command. Host config must enumerate readable/writable/creatable files, approved command IDs/argv, final acceptance and limits. Mock scripts must be ordinary fixture input independent of task IDs. The implementer fixes exact CLI/API names and schema in the usage contract before integration tests use them.

- [x] Write critical behavior tests and observe relevant red failures before implementation: external goal/repo entry, new file plus edit, red→green command, protected/out-of-scope rejection, loopback HTTP real SDK turn, transport cancellation/error, persistent UNKNOWN refusal, readonly reopen/export and tamper refusal.
- [x] Implement secure config/context/snapshot and necessary scoped file/command tools, reusing mature primitives and OS isolation where appropriate; no arbitrary shell or unrestricted host execution.
- [x] Implement ephemeral mock HTTP provider and exact transport admission; wire both official harnesses through the same tool and persisted request authority, never fake a loop.
- [x] Complete run orchestration, source preservation, final host acceptance, bounded metrics, canonical terminal state, readonly reopening and standard diff/new-file patch delivery.
- [x] Create fresh taskboard-cli cases T1 feature, T2 boundary bug, T3 known failure/cancel/unknown. Initial snapshots/acceptance fixed before runs; scripted answers only in fixture transport.
- [x] Run targeted tests for new boundary behavior and actual both-SDK CLI examples. Record exact commands, exit codes, counts and evidence paths/hashes; do not call mock turns real model work.
- [x] Update usage, eight-module evidence matrix, remaining limits and source version. No claims of general repo support, real model quality, production hostile-code sandbox or full resume.

## Task 2: Independent verification and delivery

- [x] Root checks implementation diff and critical evidence; independent reviewer checks spec and quality, reusing test receipts without routine reruns.
- [x] Resolve concrete findings and run affected checks only. Run final full npm test once after implementation is stable.
- [x] Confirm fresh taskboard CLI results, no source changes, real model requests zero, no services/processes left by fixtures, saved reports/reopen/patch and feature Git status.
- [x] Deliver usable commands and absolute file links, actual verification and limitations directly to user. Leave P1-B and formal UI unstarted, no commits/push/merge without renewed explicit action authority.

## Subsequent Git delivery authorization

After the P1-A report, the user authorized merging and pushing this increment to the existing public `momonong/calcifer` repository. This supersedes the development-phase Git restriction only. Include source, synthetic fixtures and sanitized documentation; exclude raw sessions/ledgers, credentials, private endpoints and unrelated history. P1-B model/resources and formal UI retain their separate gates.
