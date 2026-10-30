# #3330 Node worker startup root-cause handoff

## Scope and current branch

- Investigation branch: `codex/issue-3330-diagnostic-deep`.
- Worktree: `E:\work\git-repos\cindy\.cindy-worktrees\issue-3330-diagnostic-deep`.
- Baseline at 2026-09-07: `origin/main` = `63e90722e0de9e7b1db732274bdd9870337177d2`.
- This worktree is diagnostic-only and must not include the independent exit-ledger branch.

## Field evidence and current inference

The 2026-09-03 production evidence for `xd-sites` showed two attempts in one app run. Each
observed `utility-process-spawned` with a distinct PID, but neither observed `parent-port-ready`
before the 10-second timeout; both were then killed. The user-visible result was
`PROCESS_START_FAILED` with `Node 工作进程启动超时`. Network requests around the failure succeeded,
so plugin network behavior is not the default explanation.

`nodeRuntimeWorkerProcess.ts` posts its `ready` parentPort message before requiring the plugin
entry. Therefore the two existing main-side stages prove native process creation and broker
observation of the ready message, but a missing ready stage does not distinguish worker bootstrap
execution from MessagePort delivery or host-side adapter settlement. No production fix is proven.

Prior isolated v0.1.72 packaged experiments with two local real ghost fixtures, idle/restart,
hidden windows, local child-process/IPC activity, and TEMP old/new process handoff all ended
`NOT REPRODUCED`; they did not cover authenticated vendor agent/provider activity, signed updater
handoff, EDR timing, or the exact user machine state.

## Current diagnostic patch

Only `nodeRuntimeBroker.ts` and its focused test are modified for the deep diagnostic patch.
The adapter keeps in-memory `messageCount`, `readySeen`, and `adapterReady` facts. At the existing
startup timeout callback, the broker samples those facts and the adapter's best-effort `killed`
state once, storing `adapterKilledAtDeadline`; all are emitted only in the existing failed-start
warn. `adapterKilledAtDeadline: false` means only that the adapter had not marked the child
killed at the deadline; it is not confirmation that the OS PID was alive. The PID remains the
existing supplemental failure field.
The deadline stage array is copied at timeout and cannot be changed by later events. Missing or
throwing custom diagnostic getters degrade to `unknown`; logger failures remain fail-open.

The returned error, timer, retry, kill, exit, stderr activity, ready ordering, and process error
semantics are unchanged. No stderr marker/filter, extra timer, drain, polling, wait, ledger,
restart, recovery, upload allowlist, logger schema, UI, request/result/path/stderr/raw-error data,
or credentials are added.

## Validation

- Focused broker + packaging tests: 80 passed.
- Desktop typecheck: passed.
- `sourceAllowlist.test.ts`: 73 passed.
- `pnpm test:unit:related`: passed (`test:runner`: 497 passed, 8 skipped; `apps/desktop` related unit passed, 110.8s).
- `git diff --check`: passed.

Remaining work is independent tester/reviewer review and any packaged smoke explicitly arranged by
the Lead. Do not call this patch a fix without an old-versus-new A/B reproduction.
