# PI Subagent capability-parity plan

> Status: experimental parity ledger. This document is not a product rule or a staged-delivery boundary.
>
> Reference: `nicobailon/pi-subagents` (MIT), especially `README.md`,
> `docs/tool-reference.md`, `docs/observability.md`, `docs/workflows.md`,
> `docs/missions.md`, and `src/runs/background/*`.

## Product boundary

Cindy preserves what a user can accomplish with PI plus `pi-subagents`, but owns
all lifecycle, permission, storage, and UI contracts. The third-party TUI and
slash-command shell are not embedded. A Subagent remains a child of its parent
Cindy task; it does not become an Orca worker or a separate sidebar task.

The Subagents sidebar entry and detail surface are intentionally Pi-only. Pi is
the only supported harness whose child runs expose the complete multi-agent
status, transcript, result, approval, and control contract needed by this UI.
Claude Code and Codex collection may remain as internal compatibility data, but
their existing user-visible task cards and sidebar behavior do not change and
must not consume this surface.

Navigation or archive does not stop a detached child. Reopening the parent task
restores its Fleet state. Deleting the parent task requests stop for every live
child and removes durable run data after runner-owned process termination. App
exit requests runner-owned stop and waits on the graceful path; force-update
exit writes the same atomic stop controls synchronously before process exit.

## Capability matrix

| Reference capability | Cindy-native surface | Runtime/storage owner | Current experiment state |
|---|---|---|---|
| Built-in roles | `subagent` role parameter; Pi task card and Pi-only Subagents panel | PI adapter + Cindy role catalog | Implemented: scout, reviewer, planner, worker, oracle, researcher, delegate |
| Custom roles | Inline validated role prompt/tool class; settings catalog can reuse the same contract | PI adapter | Implemented per invocation; Settings editor remains product polish |
| Foreground execution | Parent turn waits on the same durable runner and receives its bounded result | PI extension + durable runner | Implemented, including Ask approval forwarding |
| Detached background execution | Launch receipt; task card and Fleet continue independently | Cindy durable runner | Implemented |
| Parallel fan-out | One batch with unique child/session identities, per-child conversations and bounded concurrency | Durable runner | Implemented, including per-child stop/steer/follow-up/resume |
| Chained/review workflows | `mode:chain` or bounded declarative `mode:workflow` DAG | Durable runner | Implemented for foreground and detached runs |
| Per-child model and thinking | Model/thinking fields with provider-aware catalog validation | PI adapter + frozen run snapshot | Implemented |
| Fresh context | Independent durable PI child session | Durable runner | Implemented |
| Forked parent context | Explicit immutable parent transcript snapshot | PI extension + durable config | Implemented with bounded user/assistant snapshot |
| Full transcript | Lazy pages in existing Subagents detail view | Host transcript resolver | Implemented with UUID-contained cursor paging |
| Returned result | Compact terminal summary on the card; complete result in Subagents detail | Durable Subagent DB projection | Implemented with a 256 KiB terminal bound and truncation marker |
| Tokens, cost, duration, tools | Card/Fleet metadata | Runner status + durable DB projection | Implemented; detached cost is shown separately from a completed parent-turn total |
| Stop | Card and Fleet stop actions | Runner control file; runner owns process handles | Implemented per run or child, locally and through device-link data-owner routing |
| Steer/follow-up | Fleet detail composer/action and tool management actions | Host IPC + runner control protocol | Implemented for active local PI durable runs |
| Resume | Fleet action restoring existing PI child session ids | Live parent PI handle + new runner generation | Implemented locally; unloaded parent must be reopened first |
| Worktree isolation | Default shared parent workdir; optional `isolation:require-worktree` enforcement when the parent already uses a worktree | Existing Cindy worktree lifecycle + PI adapter | Implemented as explicit opt-in isolation. PI never creates a hidden checkout, including for large game/LFS repositories |
| Watchdog/timeouts | Heartbeat, configurable whole-run timeout, stop escalation, bounded credential lease | Durable runner + host monitor | Implemented; explicit stale-run UI diagnosis remains |
| Missions | Recurring parent task whose prompt invokes a declared Subagent workflow | Existing Cindy Scheduler | Cindy-native mapping documented by `action:guide`; dedicated mission editor remains polish |
| Schedules | Existing Cindy Scheduler bound to the parent task | Scheduler | Available without a parallel scheduler implementation |
| Intercom | Typed steer/follow-up, approval, result, and transcript events | Host control/event protocol | Implemented without raw peer sockets |
| Herdr | Bounded dependency fan-out/fan-in graph | Durable runner | Implemented through `mode:workflow` + `dependsOn` |
| Workflow scripting | Reviewed declarative workflow schema | PI tool contract + durable runner | Implemented; arbitrary package scripts are intentionally excluded |
| Sharing | User-initiated result copy | Existing Subagents detail view | Implemented; file export remains polish |
| Doctor | `subagent {action:"doctor"}` health report | PI extension capability probes | Implemented |
| Guide/help | `action:"guide"`, tool descriptions, parity ledger | PI extension + product docs | Implemented |

## Durable-run invariants

1. Batch IDs and every child session ID are unique UUID-derived values.
2. `taskId` is an opaque lookup value and is never used as a filesystem path.
3. The host writes control requests only inside UUID-validated run directories.
4. Only the runner signals process handles it actually spawned; disk PIDs are
   diagnostic metadata, never kill authority.
5. Status, result, configuration, permission, and control files are private and
   atomically replaced. Transcript and returned-result storage are bounded.
6. A detached run freezes the model catalog, permission snapshot, and bridge
   source it needs before the parent PI config directory can be removed.
7. The parent gateway proxy credential remains leased only while a durable child
   is live, then is revoked. Inspection failure fails closed.
8. Parent navigation closes only the observer. Parent deletion requests stop,
   waits for runner-owned termination, and removes the run root only after all
   readable runs are terminal.
9. Ask/Auto descendant writes use child RPC approval requests forwarded to the
   existing Cindy approval UI. Missing resolver, malformed request, delivery
   failure, or timeout fails closed; Full Access remains the only no-prompt mode.
10. Device-link and SSH controls must execute on the data-owning device. A local
    renderer must not present a stop action that targets an unreachable remote
    session.

## Final acceptance checklist

This is one parity task, not a staged delivery plan. The in-scope implementation
is complete in this experiment, including stale/corrupt-run diagnosis. The
remaining work is acceptance evidence rather than another product phase:

- run the repository related-unit, affected-package typecheck, migration replay,
  schema validation, and i18n glossary gates;
- exercise empty, loading, diagnostic, error, queued, multi-child, approval,
  stop, steer, follow-up, resume, and parent-deletion/exit lifecycle states in a
  fresh isolated Desktop profile, including narrow layout and Light/Dark themes;
- complete at least two real Cindy Host runs and verify returned result, full
  transcript, model/thinking metadata, tokens, cost, duration, tool count,
  approval/control behavior, and proxy-credential lease cleanup;
- independently review the complete diff and resolve every reproducible P0-P2
  finding before handing the experiment to the user for acceptance.

Dedicated mission/settings editors and result-file export are product polish
because the same outcomes already use Cindy Scheduler, inline roles, and
standard result copy. SSH-hosted PI is a separate unsupported transport boundary
and is explicitly outside this PR; device-link reads and controls execute on the
data-owning device and are PI-only at the Host boundary.

## Required process-level tests

- Exact PI argv (`--session-id`, never creation through `--session`).
- Parallel child/session isolation.
- Parent close while queued and active children continue using frozen routing.
- Proxy credential lease survives parent close and is revoked at terminal state.
- Stop produces `stopped`, not `failed`, and never signals a stale disk PID.
- Timeout prevents queued children from launching.
- Oversized output remains readable through bounded status/result files.
- Recovery after host/session restart re-emits the latest durable state.
- Parent deletion stops the process tree before removing durable files.
- Device-link/SSH controls never fall back to the controller's local filesystem.
