# Orca workflow

Shared collaboration logic for Cindy hosts. The package has no Electron, desktop singleton, filesystem database, or application-window dependency.

- `@cindy/orca-workflow` retains the existing MCP bridge, message formatting and prompts.
- `@cindy/orca-workflow/host/orcaLifecycleService` owns team activation, worker initialization and compensation.
- `@cindy/orca-workflow/host/orcaWorkerCreationService` owns model admission, creation reservations, worker routes and creation rollback.
- `@cindy/orca-workflow/host/orcaTeamService` owns worker controls, accepted-dispatch settlement, queue controls and terminal reports.
- `@cindy/orca-workflow/host/orcaInterAgentDispatcher` owns direct, queued and same-turn delivery. Hosts supply storage, session, queue and logging ports. Keep the dependency object live: hosts may update these ports while a dispatcher is running.
- `@cindy/orca-workflow/host/orcaRemoteWorkerRuntime` owns remote dispatch receipts, reachability, polling and report settlement.
- `@cindy/orca-workflow/host/orcaRemoteWorkers` composes execution-device discovery, remote opening, proxy registration, cleanup retries and the shared team controls against host storage ports.
- `@cindy/orca-workflow/host/orcaSessionStartOptions` restores persisted collaboration identity and applies the existing role prompts. Each host owns its optional non-Orca cache.
- `@cindy/orca-workflow/host/orcaRemoteWorkerHost` handles authenticated remote worker creation and release. The host must save task identity and Lead attribution in the same commit; explicit Worker tools are advertised separately from automatic report polling.

The remote Worker MCP provider shares the local Worker tool schemas and caller checks, with no local Lead fallback. `host/orcaRemoteWorkerBridge` forwards only through the persisted Lead link and host-captured accepted input identities.

Desktop adapters preserve the existing imports and logger defaults. Host adapters must implement the full port contracts, including ownership rechecks and accepted/rollback/commit ordering. Extracting these services does not, by itself, enable collaboration in another host.

The existing Desktop lifecycle, worker creation, dispatch, queue and permission regression tests exercise these shared implementations. The product contract remains `docs/dev-rules/orca-team-architecture.md`.

The terminal host persists teams, reservations, remote receipts and task changes in one private journal under its exclusive profile writer. It materializes committed task changes before serving collaboration reads and replays incomplete materialization at startup. Unknown commit outcomes block further writes until restart. Portable profile backups include this state.

The terminal host wires these services to the existing GUI IPC and `cindy_orca` / Worker MCP protocols. Local Worker results have an outbox on the accepted input receipt: completed history can reconstruct an unprepared report, and retries reuse the Lead input identity after a lost acknowledgement. This recovery never replays the Worker's task. Explicit stop suppresses pending reports; team membership is revalidated before delivery.

Diagnostics, UI assignment history barriers, idle runtime release, and plugin Worker completion checks are shared with Desktop. Terminal plugin teams use their registered model/directory plan and current Auto authorization, with completion timestamps checked again before release. Native cross-platform acceptance exercises the same public terminal task host and original shared-service tests. Worktree-backed Worker creation still requires a terminal workspace adapter.
