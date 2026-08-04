/**
 * Node 25 installs the WebStorage globals by default, and with no
 * `--localstorage-file` configured `globalThis.localStorage` is a stub whose
 * methods are all missing: under the node environment it fools a
 * `typeof localStorage !== 'undefined'` probe, and under jsdom the pre-existing
 * key displaces jsdom's working implementation, because Vitest skips populating
 * globals that already exist. `--no-experimental-webstorage` restores the
 * original semantics; on Node 22 (local dev and CI) the global never exists, so
 * the flag is a pure no-op there.
 *
 * The flag and the threads pool are mutually exclusive: passing custom execArgv
 * to worker threads segfaults the isolate during teardown. Measured 2026-07-30:
 * 2 of 10 full desktop unit runs crashed inside
 * node::worker::WorkerThreadData::~WorkerThreadData -> final GC ->
 * GlobalHandles::InvokeFirstPassWeakCallbacks, i.e. a native addon finalizer
 * touching freed memory as the isolate went away; 8 further runs with the
 * execArgv removed produced none. apps/desktop therefore hands the flag to the
 * forks pool only, and never to threads.
 *
 * That leaves the pool choice, which is what this predicate decides (see
 * UNIT_POOL_DEFAULT in scripts/test-workspaces.config.mjs): where the flag is
 * genuinely needed, apps/desktop keeps today's behaviour and stays on forks so
 * the flag still applies; where it is a no-op, the unit tier takes threads
 * instead, which spawns no process per test file.
 */
export function nodeWebstorageEnabled(globalObject = globalThis) {
  return typeof globalObject.localStorage !== 'undefined';
}
