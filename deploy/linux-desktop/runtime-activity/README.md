# Task activity overlay

Replaces the `activity-unknown` placeholder in the instance status with live task
activity, so the control service does not restart an instance that is working.

Sources: agent turns, Claude and plugin background activity, background Bash, slot jobs,
Pi subagents; queued input, compaction, pending interactions and settling dispatches;
running, queued and imminent (two minutes) scheduled runs; remote calls and remote
desktop input. A new kind of task execution must be added here with busy and unknown
tests.

Rules:

- A missing source, error, invalid value, timeout (1 s) or owner change reports
  `activity-unknown` with a specific blocker.
- In-memory sources are read before and after the asynchronous ones. At most one scan
  runs at a time.
- `idle` needs two samples and 10 s of quiet.
- An automatic schedule without a next fire time is accepted only while its own run is in
  flight, which is reported as busy.
- The status is published every 5 s; a late scan never overwrites `stopping`. Session
  IDs, text and credentials are never written.

`idle.maySuspend` stays `false`. The reading is an observation, not a drain lock: check
the live status and the maintenance gate before acting on it.

`overlay.mjs` transforms `bootstrap-electron.ts`, `instance-runtime/status.ts`,
`maker-ipc/register.ts` and `maker-ipc/agent-input-coordinator.ts`; `publisher.mjs` is the
injected module, also used by `runtime-maintenance`.

```sh
CINDY_ACTIVITY_TEST_SOURCE="$PWD" node --test deploy/linux-desktop/runtime-activity/*.test.mjs
```

Without the variable the tests of real client sources are skipped.
